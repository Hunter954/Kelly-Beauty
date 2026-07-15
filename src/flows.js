const { getOrCreateUser, updateUser, logMessage } = require('./db');
const config = require('./config');
const appt = require('./services/appointment-service');
const { normalizeText, money, dateBR, timeBR } = require('./utils/format');

async function send(client, jid, text, userId) {
  const body = String(text || '').replace(/\\n/g, '\n');
  await client.sendText(jid, body);
  await logMessage({ userId, whatsappJid: jid, direction: 'out', body });
}

const masculineNames = new Set([
  'william','joao','jose','carlos','paulo','pedro','lucas','gabriel','rafael','marcos','marco','mateus','matheus','bruno','daniel','diego','eduardo','felipe','fernando','gustavo','henrique','igor','leandro','leonardo','luiz','luis','marcelo','murilo','nicolas','renato','ricardo','roberto','rodrigo','samuel','thiago','tiago','vinicius','vitor','victor','wesley','anderson','alexandre','antonio','fabio','fabricio','jorge','julio','mauricio','otavio','sergio'
]);

function welcomeExpression(name) {
  const first = normalizeText(String(name || '').split(/\s+/)[0]);
  return masculineNames.has(first) ? 'seja bem-vindo' : 'seja bem-vinda';
}

async function menu(name) {
  const saved = await config.get(
    'welcome_message',
    'Olá, seja bem-vindo(a) à Kelly Rodrigues Beauty Studio! ✨\n\n' +
      'Como podemos cuidar de você hoje?\n\n' +
      '1️⃣ Agendar um serviço\n' +
      '2️⃣ Ver nossos serviços\n' +
      '3️⃣ Consultar meu agendamento\n' +
      '4️⃣ Reagendar ou cancelar\n' +
      '5️⃣ Endereço e contato\n' +
      '6️⃣ Falar com uma atendente\n\n' +
      'Digite o número da opção desejada.'
  );
  const expression = welcomeExpression(name);
  return String(saved)
    .replace(/seja bem-vindo\(a\)/gi, expression)
    .replace(/seja bem-vinda/gi, expression)
    .replace(/seja bem-vindo/gi, expression);
}

function emojiNumber(value) {
  return String(value).split('').map((digit) => `${digit}\uFE0F\u20E3`).join('');
}

function parseOption(value) {
  const digits = String(value || '').replace(/[\uFE0F\u20E3\s]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

function numbered(items, label) {
  return items.map((item, index) => `${emojiNumber(index + 1)} ${label(item)}`).join('\n');
}

function isBookingStep(step) {
  return [
    'booking_category',
    'booking_service',
    'booking_professional',
    'booking_date',
    'booking_time',
    'booking_confirm'
  ].includes(step);
}

async function reset(user, step = 'main_menu') {
  await appt.releaseHolds(user.id);
  return updateUser(user.id, { onboarding_step: step, onboarding_data: {} });
}

async function openSupport(client, jid, user) {
  await updateUser(user.id, {
    onboarding_step: 'support',
    support_status: 'open',
    support_requested_at: new Date(),
    support_opened_at: new Date(),
    support_closed_at: null,
    support_last_message_at: new Date(),
    lead_status: 'support'
  });
  await send(
    client,
    jid,
    'Certo! Vou encaminhar sua conversa para nossa equipe. 💛\n\nAssim que possível, uma atendente continuará por aqui.',
    user.id
  );
  if (client.setChatArchived) await client.setChatArchived(jid, false);
  return true;
}

async function startBooking(client, jid, user) {
  const categories = await appt.listCategories();
  if (!categories.length) {
    return send(client, jid, 'Os serviços ainda estão sendo configurados. Digite *ATENDENTE* para falar com a equipe.', user.id);
  }

  await updateUser(user.id, {
    onboarding_step: 'booking_category',
    onboarding_data: { categories: categories.map((item) => item.id) }
  });

  return send(
    client,
    jid,
    `Escolha uma categoria:\n\n${numbered(categories, (item) => item.name)}\n${emojiNumber(categories.length + 1)} Voltar ao menu`,
    user.id
  );
}

async function handleBookingStep(client, jid, text, normalized, user) {
  const data = user.onboarding_data || {};

  if (normalized === 'menu' || normalized === 'inicio' || normalized === 'cancelar agendamento') {
    await reset(user);
    return send(client, jid, await menu(user.name), user.id);
  }

  if (user.onboarding_step === 'booking_category') {
    const categories = await appt.listCategories();
    const option = parseOption(normalized);

    if (option === categories.length + 1) {
      await reset(user);
      return send(client, jid, await menu(user.name), user.id);
    }

    const category = categories[option - 1];
    if (!category) {
      return send(client, jid, 'Escolha uma das categorias numeradas ou digite *MENU* para sair.', user.id);
    }

    const services = await appt.listServices(category.id);
    if (!services.length) {
      return send(client, jid, 'Essa categoria ainda não possui serviços ativos. Escolha outra opção ou digite *MENU*.', user.id);
    }

    await updateUser(user.id, {
      onboarding_step: 'booking_service',
      onboarding_data: {
        categoryId: category.id,
        serviceIds: services.map((item) => item.id)
      }
    });

    return send(
      client,
      jid,
      `Qual serviço você deseja?\n\n${numbered(services, (item) => item.name)}\n${emojiNumber(services.length + 1)} Voltar às categorias`,
      user.id
    );
  }

  if (user.onboarding_step === 'booking_service') {
    const services = await appt.listServices(data.categoryId);
    const option = parseOption(normalized);

    if (option === services.length + 1) {
      return startBooking(client, jid, user);
    }

    const service = services[option - 1];
    if (!service) {
      return send(client, jid, 'Escolha um dos serviços numerados ou digite *MENU* para sair.', user.id);
    }

    if (!service.duration_minutes) {
      return send(
        client,
        jid,
        'Este serviço ainda está sem duração configurada e não pode mostrar horários. Escolha outro serviço ou digite *ATENDENTE*.',
        user.id
      );
    }

    const professionals = await appt.listProfessionals(service.id);
    if (!professionals.length) {
      return send(client, jid, 'Este serviço ainda não possui profissional configurada. Digite *ATENDENTE* para falar com a equipe.', user.id);
    }

    if (professionals.length === 1) {
      const dates = await appt.nextDates(service.id, professionals[0].id);
      await updateUser(user.id, {
        onboarding_step: 'booking_date',
        onboarding_data: {
          categoryId: data.categoryId,
          serviceId: service.id,
          professionalId: professionals[0].id,
          dates
        }
      });

      if (!dates.length) {
        return send(
          client,
          jid,
          'Não encontrei horários disponíveis nos próximos dias. Digite *MENU* para escolher outro serviço ou *ATENDENTE* para falar com a equipe.',
          user.id
        );
      }

      return send(
        client,
        jid,
        `Estas são as próximas datas disponíveis para *${service.name}*:\n\n${numbered(dates, (item) => dateBR(`${item.date}T12:00:00-03:00`))}\n${emojiNumber(dates.length + 1)} Voltar aos serviços`,
        user.id
      );
    }

    await updateUser(user.id, {
      onboarding_step: 'booking_professional',
      onboarding_data: {
        categoryId: data.categoryId,
        serviceId: service.id,
        professionalIds: professionals.map((item) => item.id)
      }
    });

    return send(
      client,
      jid,
      `Escolha a profissional:\n\n1️⃣ Primeira disponível\n${professionals.map((item, index) => `${emojiNumber(index + 2)} ${item.name}`).join('\n')}\n${emojiNumber(professionals.length + 2)} Voltar aos serviços`,
      user.id
    );
  }

  if (user.onboarding_step === 'booking_professional') {
    const professionals = await appt.listProfessionals(data.serviceId);
    const option = parseOption(normalized);

    if (option === professionals.length + 2) {
      const services = await appt.listServices(data.categoryId);
      await updateUser(user.id, {
        onboarding_step: 'booking_service',
        onboarding_data: { categoryId: data.categoryId, serviceIds: services.map((item) => item.id) }
      });
      return send(
        client,
        jid,
        `Qual serviço você deseja?\n\n${numbered(services, (item) => item.name)}\n${emojiNumber(services.length + 1)} Voltar às categorias`,
        user.id
      );
    }

    const professional = option === 1 ? professionals[0] : professionals[option - 2];
    if (!professional) {
      return send(client, jid, 'Escolha uma das profissionais numeradas.', user.id);
    }

    const dates = await appt.nextDates(data.serviceId, professional.id);
    await updateUser(user.id, {
      onboarding_step: 'booking_date',
      onboarding_data: { ...data, professionalId: professional.id, dates }
    });

    if (!dates.length) {
      return send(
        client,
        jid,
        'Não encontrei horários para essa profissional. Digite *MENU* para tentar outro serviço ou *ATENDENTE* para falar com a equipe.',
        user.id
      );
    }

    return send(
      client,
      jid,
      `Datas disponíveis:\n\n${numbered(dates, (item) => dateBR(`${item.date}T12:00:00-03:00`))}\n${emojiNumber(dates.length + 1)} Voltar`,
      user.id
    );
  }

  if (user.onboarding_step === 'booking_date') {
    const option = parseOption(normalized);
    const dates = data.dates || [];

    if (option === dates.length + 1) {
      const services = await appt.listServices(data.categoryId);
      await updateUser(user.id, {
        onboarding_step: 'booking_service',
        onboarding_data: { categoryId: data.categoryId, serviceIds: services.map((item) => item.id) }
      });
      return send(
        client,
        jid,
        `Escolha novamente o serviço:\n\n${numbered(services, (item) => item.name)}\n${emojiNumber(services.length + 1)} Voltar às categorias`,
        user.id
      );
    }

    const chosen = dates[option - 1];
    if (!chosen) {
      return send(client, jid, 'Escolha uma das datas numeradas.', user.id);
    }

    const freshSlots = await appt.availableSlots(data.serviceId, data.professionalId, chosen.date, user.id);
    if (!freshSlots.length) {
      const freshDates = await appt.nextDates(data.serviceId, data.professionalId);
      await updateUser(user.id, {
        onboarding_step: 'booking_date',
        onboarding_data: { ...data, dates: freshDates, slots: undefined, selectedDate: undefined }
      });
      return send(
        client,
        jid,
        `Os horários dessa data foram preenchidos. Estas são as próximas datas disponíveis:

${numbered(freshDates, (item) => dateBR(`${item.date}T12:00:00-03:00`))}`,
        user.id
      );
    }

    await updateUser(user.id, {
      onboarding_step: 'booking_time',
      onboarding_data: { ...data, selectedDate: chosen.date, slots: freshSlots }
    });

    return send(
      client,
      jid,
      `Horários disponíveis em ${dateBR(`${chosen.date}T12:00:00-03:00`)}:

${numbered(freshSlots, (slot) => timeBR(slot))}
${emojiNumber(freshSlots.length + 1)} Escolher outra data`,
      user.id
    );
  }

  if (user.onboarding_step === 'booking_time') {
    const option = parseOption(normalized);
    const slots = data.slots || [];

    if (option === slots.length + 1) {
      await appt.releaseHolds(user.id);
      const dates = await appt.nextDates(data.serviceId, data.professionalId);
      await updateUser(user.id, {
        onboarding_step: 'booking_date',
        onboarding_data: { ...data, dates, slots: undefined, selectedDate: undefined }
      });
      return send(
        client,
        jid,
        `Escolha outra data:\n\n${numbered(dates, (item) => dateBR(`${item.date}T12:00:00-03:00`))}\n${emojiNumber(dates.length + 1)} Voltar aos serviços`,
        user.id
      );
    }

    const slot = slots[option - 1];
    if (!slot) {
      return send(client, jid, 'Escolha um dos horários numerados.', user.id);
    }

    const freshSlots = await appt.availableSlots(data.serviceId, data.professionalId, data.selectedDate, user.id);
    if (!freshSlots.includes(slot)) {
      await updateUser(user.id, {
        onboarding_step: 'booking_time',
        onboarding_data: { ...data, slots: freshSlots, startsAt: undefined }
      });
      return send(
        client,
        jid,
        `Esse horário não está mais disponível. Escolha uma das opções atualizadas:

${numbered(freshSlots, (item) => timeBR(item))}
${emojiNumber(freshSlots.length + 1)} Escolher outra data`,
        user.id
      );
    }

    try {
      await appt.holdSlot({
        clientId: user.id,
        serviceId: data.serviceId,
        professionalId: data.professionalId,
        startsAt: slot
      });
    } catch (_) {
      const updatedSlots = await appt.availableSlots(data.serviceId, data.professionalId, data.selectedDate, user.id);
      await updateUser(user.id, {
        onboarding_step: 'booking_time',
        onboarding_data: { ...data, slots: updatedSlots, startsAt: undefined }
      });
      return send(
        client,
        jid,
        `Esse horário acabou de ser reservado por outra pessoa. Escolha uma das opções atualizadas:

${numbered(updatedSlots, (item) => timeBR(item))}
${emojiNumber(updatedSlots.length + 1)} Escolher outra data`,
        user.id
      );
    }

    const service = await appt.getService(data.serviceId);
    const professionals = await appt.listProfessionals(data.serviceId);
    const professional = professionals.find((item) => Number(item.id) === Number(data.professionalId));

    await updateUser(user.id, {
      onboarding_step: 'booking_confirm',
      onboarding_data: { ...data, startsAt: slot }
    });

    const price = service.price_cents
      ? `\n💰 ${money(service.promotional_price_cents || service.price_cents)}`
      : '';

    return send(
      client,
      jid,
      `Confira seu agendamento:\n\n✨ Serviço: ${service.name}\n👩 Profissional: ${professional?.name || 'Kelly Rodrigues'}\n📅 ${dateBR(slot)}\n🕐 ${timeBR(slot)}\n⏳ Duração aproximada: ${service.duration_minutes} minutos${price}\n\n1️⃣ Confirmar agendamento\n2️⃣ Escolher outro horário\n3️⃣ Voltar ao menu`,
      user.id
    );
  }

  if (user.onboarding_step === 'booking_confirm') {
    if (normalized === '2') {
      await appt.releaseHolds(user.id);
      const dates = await appt.nextDates(data.serviceId, data.professionalId);
      await updateUser(user.id, {
        onboarding_step: 'booking_date',
        onboarding_data: { ...data, dates, slots: undefined, startsAt: undefined }
      });
      return send(
        client,
        jid,
        `Escolha uma nova data:\n\n${numbered(dates, (item) => dateBR(`${item.date}T12:00:00-03:00`))}`,
        user.id
      );
    }

    if (normalized === '3') {
      await reset(user);
      return send(client, jid, await menu(user.name), user.id);
    }

    if (normalized !== '1') {
      return send(client, jid, 'Digite 1 para confirmar, 2 para alterar o horário ou 3 para voltar ao menu.', user.id);
    }

    try {
      const appointment = await appt.createAppointment({
        clientId: user.id,
        serviceId: data.serviceId,
        professionalId: data.professionalId,
        startsAt: data.startsAt,
        origin: 'whatsapp'
      });
      const service = await appt.getService(data.serviceId);
      await reset(user);
      return send(
        client,
        jid,
        `Agendamento confirmado com sucesso! ✨\n\nServiço: ${service.name}\nData: ${dateBR(appointment.starts_at)}\nHorário: ${timeBR(appointment.starts_at)}\nLocal: Av. Brasil, 665 — Galeria Edine — Sala 24\n\nCódigo do agendamento: *${appointment.public_code}*\n\nRecomendamos chegar com 5 minutos de antecedência.`,
        user.id
      );
    } catch (error) {
      console.error('Erro ao confirmar agendamento pelo WhatsApp:', error);

      if (error?.code === 'SLOT_UNAVAILABLE') {
        const dates = await appt.nextDates(data.serviceId, data.professionalId);
        await updateUser(user.id, {
          onboarding_step: 'booking_date',
          onboarding_data: { ...data, dates, slots: undefined, startsAt: undefined }
        });
        return send(
          client,
          jid,
          `Esse horário realmente não está mais disponível. Escolha uma nova data:

${numbered(dates, (item) => dateBR(`${item.date}T12:00:00-03:00`))}`,
          user.id
        );
      }

      return send(
        client,
        jid,
        'Não consegui concluir o agendamento por uma falha momentânea do sistema. Seu horário continua selecionado. Digite *1* para tentar confirmar novamente, *2* para escolher outro horário ou *3* para voltar ao menu.',
        user.id
      );
    }
  }

  await reset(user);
  return send(client, jid, await menu(user.name), user.id);
}

async function handleIncomingMessage(client, message) {
  const jid = message.from;
  const text = String(message.body || '').trim();
  const normalized = normalizeText(text);
  let user = await getOrCreateUser(jid);

  if (message.phone && !user.phone) {
    user = await updateUser(user.id, { phone: message.phone });
  }

  await logMessage({
    userId: user.id,
    whatsappJid: jid,
    direction: 'in',
    body: text || '[mensagem sem texto]',
    raw: message.raw || null
  });

  if (user.support_status === 'open' || user.onboarding_step === 'support') {
    await updateUser(user.id, {
      support_status: 'open',
      support_opened_at: user.support_opened_at || new Date(),
      support_last_message_at: new Date(),
      support_unread_count: Number(user.support_unread_count || 0) + 1,
      lead_status: 'support'
    });
    return;
  }

  // Comandos globais por palavra podem ser usados em qualquer etapa.
  if (['atendente', 'suporte'].includes(normalized) || normalized.includes('falar com atendente')) {
    return openSupport(client, jid, user);
  }

  if (['menu', 'inicio', 'comecar'].includes(normalized)) {
    await reset(user);
    return send(client, jid, await menu(user.name), user.id);
  }

  if (!user.name && user.onboarding_step !== 'ask_name') {
    await updateUser(user.id, { onboarding_step: 'ask_name' });
    return send(client, jid, 'Antes de começarmos, qual é o seu nome? 😊', user.id);
  }

  if (user.onboarding_step === 'ask_name') {
    const name = text.replace(/[^\p{L}\s'-]/gu, '').trim().slice(0, 80);
    if (name.length < 2) {
      return send(client, jid, 'Pode me informar seu nome, por favor? 😊', user.id);
    }
    user = await updateUser(user.id, { name, onboarding_step: 'main_menu', onboarding_data: {} });
    return send(client, jid, `Prazer, ${name}! ✨\n\n${await menu(name)}`, user.id);
  }

  // Durante o agendamento, números pertencem à etapa atual e nunca ao menu principal.
  if (isBookingStep(user.onboarding_step)) {
    return handleBookingStep(client, jid, text, normalized, user);
  }

  if (!text || ['oi', 'ola'].includes(normalized)) {
    await reset(user);
    return send(client, jid, await menu(user.name), user.id);
  }

  if (normalized === '1' || normalized.includes('agendar') || normalized.includes('marcar horario')) {
    return startBooking(client, jid, user);
  }

  if (normalized === '2' || normalized.includes('servicos')) {
    const categories = await appt.listCategories();
    const groups = [];
    for (const category of categories) {
      const services = await appt.listServices(category.id);
      groups.push(
        `*${category.name}*\n${services
          .map((service) => `• ${service.name}${service.price_type === 'exact' && service.price_cents ? ` — ${money(service.price_cents)}` : ''}`)
          .join('\n')}`
      );
    }
    return send(client, jid, `${groups.join('\n\n')}\n\nDigite *AGENDAR* para marcar seu horário.`, user.id);
  }

  if (normalized === '3' || normalized.includes('meu agendamento') || normalized.includes('consultar')) {
    const rows = await appt.upcoming(user.id);
    if (!rows.length) {
      return send(client, jid, 'Você não possui agendamentos futuros.\n\nDigite *AGENDAR* para escolher um horário.', user.id);
    }
    const body = rows
      .map(
        (appointment, index) =>
          `${emojiNumber(index + 1)} *${appointment.service_name}*\n📅 ${dateBR(appointment.starts_at)}\n🕐 ${timeBR(appointment.starts_at)}\n👩 ${appointment.professional_name}\nCódigo: ${appointment.public_code}`
      )
      .join('\n\n');
    return send(
      client,
      jid,
      `Seus próximos agendamentos:\n\n${body}\n\nPara alterações, envie *ATENDENTE* ou acesse a opção 4.`,
      user.id
    );
  }

  if (normalized === '4' || normalized.includes('reagendar') || normalized.includes('cancelar')) {
    return send(
      client,
      jid,
      'Para proteger seu horário, vou encaminhar a solicitação para nossa equipe. Digite *ATENDENTE* e informe o código do agendamento.',
      user.id
    );
  }

  if (normalized === '5' || normalized.includes('endereco') || normalized.includes('contato')) {
    return send(
      client,
      jid,
      '📍 Av. Brasil, 665 — Galeria Edine — Sala 24\n📞 45 99846-7053\n📸 @kellylingerie_store\n\nDigite *MENU* para voltar.',
      user.id
    );
  }

  if (normalized === '6') {
    return openSupport(client, jid, user);
  }

  return send(client, jid, await menu(user.name), user.id);
}

module.exports = { handleIncomingMessage };
