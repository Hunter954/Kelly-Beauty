const express=require('express');const {query,formatPhoneForAdmin,logMessage}=require('../db');const {sendText,getBotState}=require('../bot');const {dateBR,timeBR}=require('../utils/format');const appt=require('../services/appointment-service');const router=express.Router();
function auth(req,res,next){if(req.session?.adminLoggedIn)return next();res.redirect('/admin/login');}
router.get('/agenda',auth,async(req,res,next)=>{try{
 const date=req.query.date||new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const status=String(req.query.status||'');
 const serviceId=String(req.query.service||'');
 const professionalId=String(req.query.professional||'');
 const search=String(req.query.q||'').trim();
 const rows=(await query(`SELECT a.*,u.name client_name,u.phone,u.whatsapp_jid,s.name service_name,p.name professional_name
   FROM appointments a JOIN users u ON u.id=a.client_id JOIN services s ON s.id=a.service_id JOIN professionals p ON p.id=a.professional_id
   WHERE (a.starts_at AT TIME ZONE 'America/Sao_Paulo')::date=$1
     AND ($2='' OR a.status=$2)
     AND ($3='' OR a.service_id::text=$3)
     AND ($4='' OR a.professional_id::text=$4)
     AND ($5='' OR u.name ILIKE '%'||$5||'%' OR u.phone ILIKE '%'||$5||'%' OR s.name ILIKE '%'||$5||'%')
   ORDER BY a.starts_at`,[date,status,serviceId,professionalId,search])).rows;
 const services=(await query('SELECT id,name FROM services WHERE active=TRUE ORDER BY name')).rows;
 const professionals=(await query('SELECT id,name FROM professionals WHERE active=TRUE ORDER BY name')).rows;
 const summary=(await query(`SELECT COUNT(*)::int total,
   COUNT(*) FILTER(WHERE status IN ('confirmed','pending','rescheduled'))::int active,
   COUNT(*) FILTER(WHERE status='completed')::int completed,
   COUNT(*) FILTER(WHERE status LIKE 'cancelled%')::int cancelled
   FROM appointments WHERE (starts_at AT TIME ZONE 'America/Sao_Paulo')::date=$1`,[date])).rows[0];
 res.render('admin/agenda',{rows,date,status,serviceId,professionalId,search,services,professionals,summary,formatPhone:formatPhoneForAdmin});
}catch(e){next(e)}});
router.get('/appointments',auth,async(req,res,next)=>{try{const rows=(await query(`SELECT a.*,u.name client_name,u.phone,s.name service_name,p.name professional_name FROM appointments a JOIN users u ON u.id=a.client_id JOIN services s ON s.id=a.service_id JOIN professionals p ON p.id=a.professional_id ORDER BY a.starts_at DESC LIMIT 500`)).rows;res.render('admin/appointments',{rows,formatPhone:formatPhoneForAdmin});}catch(e){next(e)}});
router.post('/appointments/:id/status',auth,async(req,res,next)=>{try{
 const status=String(req.body.status||'');
 const allowed=['pending','confirmed','rescheduled','in_progress','completed','no_show','cancelled_by_client','cancelled_by_business'];
 if(!allowed.includes(status)) return res.status(400).send('Status inválido.');
 const previous=(await query(`SELECT a.*,u.id client_id,u.name client_name,u.whatsapp_jid,s.name service_name,p.name professional_name FROM appointments a JOIN users u ON u.id=a.client_id JOIN services s ON s.id=a.service_id JOIN professionals p ON p.id=a.professional_id WHERE a.id=$1`,[req.params.id])).rows[0];
 if(!previous) return res.status(404).send('Agendamento não encontrado.');
 await query(`UPDATE appointments SET status=$2,updated_at=NOW(),last_changed_by=$3,completed_at=CASE WHEN $2='completed' THEN NOW() ELSE completed_at END,cancelled_at=CASE WHEN $2 LIKE 'cancelled%' THEN NOW() ELSE cancelled_at END WHERE id=$1`,[req.params.id,status,req.session.adminUser]);
 await query(`INSERT INTO appointment_history(appointment_id,action,previous_data,new_data,actor_type,actor_id) VALUES($1,$2,$3,$4,'admin',$5)`,[req.params.id,status,JSON.stringify({status:previous.status}),JSON.stringify({status}),req.session.adminUser]);
 if(status==='cancelled_by_business' && previous.status!=='cancelled_by_business' && previous.whatsapp_jid && getBotState().ready){
   const body=`Olá, ${previous.client_name || 'tudo bem'}! 💛\n\nSeu agendamento foi *cancelado pelo estabelecimento*.\n\n✨ Serviço: ${previous.service_name}\n📅 Data: ${dateBR(previous.starts_at)}\n🕐 Horário: ${timeBR(previous.starts_at)}\n👩 Profissional: ${previous.professional_name}\n\nPara escolher um novo horário, envie *AGENDAR*. Se precisar de ajuda, envie *ATENDENTE* para falar com nossa equipe.`;
   try{await sendText(previous.whatsapp_jid,body);await logMessage({userId:previous.client_id,whatsappJid:previous.whatsapp_jid,direction:'out',body});}catch(sendError){console.error('Falha ao avisar cancelamento:',sendError.message)}
 }
 res.redirect(req.body.returnTo||'/admin/appointments');
}catch(e){next(e)}});
router.get('/services',auth,async(req,res,next)=>{try{const rows=(await query(`SELECT s.*,c.name category_name FROM services s JOIN service_categories c ON c.id=s.category_id ORDER BY c.display_order,s.display_order`)).rows;res.render('admin/services',{rows,saved:req.query.saved==='1'});}catch(e){next(e)}});
router.post('/services/:id',auth,async(req,res,next)=>{try{const duration=req.body.duration_minutes?Number(req.body.duration_minutes):null,price=req.body.price?Math.round(Number(String(req.body.price).replace(',','.'))*100):null;await query(`UPDATE services SET duration_minutes=$2,buffer_minutes=$3,price_cents=$4,price_type=$5,active=$6,description=$7,updated_at=NOW() WHERE id=$1`,[req.params.id,duration,Number(req.body.buffer_minutes||0),price,req.body.price_type||'hidden',req.body.active==='on',String(req.body.description||'')]);res.redirect('/admin/services?saved=1');}catch(e){next(e)}});
router.get('/professionals',auth,async(req,res,next)=>{try{const rows=(await query('SELECT * FROM professionals ORDER BY active DESC,name')).rows;res.render('admin/professionals',{rows});}catch(e){next(e)}});
router.get('/clients',auth,async(req,res,next)=>{try{const q=String(req.query.q||''),rows=(await query(`SELECT u.*,COUNT(a.id)::int appointment_count,MAX(a.starts_at) FILTER(WHERE a.starts_at>=NOW()) next_appointment FROM users u LEFT JOIN appointments a ON a.client_id=u.id WHERE ($1='' OR u.name ILIKE '%'||$1||'%' OR u.phone ILIKE '%'||$1||'%') GROUP BY u.id ORDER BY u.last_interaction_at DESC LIMIT 400`,[q])).rows;res.render('admin/clients',{rows,q,formatPhone:formatPhoneForAdmin});}catch(e){next(e)}});
module.exports=router;
