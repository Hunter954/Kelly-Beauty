-- Corrige textos salvos anteriormente com os caracteres literais \n e \r\n.
-- A operação é idempotente e preserva todas as demais configurações.
UPDATE app_settings
SET value = replace(replace(replace(value, E'\\r\\n', E'\n'), E'\\n', E'\n'), E'\\r', E'\n'),
    updated_at = NOW()
WHERE value LIKE '%\\n%'
   OR value LIKE '%\\r%';

-- Garante uma mensagem inicial correta caso o campo esteja vazio.
UPDATE app_settings
SET value = E'Olá, seja bem-vinda à Kelly Rodrigues Beauty Studio! ✨\n\nComo podemos cuidar de você hoje?\n\n1️⃣ Agendar um serviço\n2️⃣ Ver nossos serviços\n3️⃣ Consultar meu agendamento\n4️⃣ Reagendar ou cancelar\n5️⃣ Endereço e contato\n6️⃣ Falar com uma atendente\n\nDigite o número da opção desejada.',
    updated_at = NOW()
WHERE key = 'welcome_message'
  AND COALESCE(trim(value), '') = '';
