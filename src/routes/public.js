const express = require('express');
const router = express.Router();
router.get('/', (req, res) => res.redirect('/admin/login'));
router.get('/pagamento/:status', (req, res) => {
  const messages = {
    sucesso: ['Pagamento recebido', 'Assim que o Mercado Pago confirmar a aprovação, você receberá o acesso pelo WhatsApp.'],
    pendente: ['Pagamento pendente', 'Acompanhe a confirmação no WhatsApp. Alguns meios de pagamento podem levar mais tempo.'],
    falhou: ['Pagamento não concluído', 'Volte ao WhatsApp e solicite um novo link digitando 2.']
  };
  const content = messages[req.params.status] || messages.pendente;
  res.send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>REIVILO</title><style>body{margin:0;background:#0e1512;color:#f5efd9;font-family:Arial;display:grid;place-items:center;min-height:100vh;padding:24px}.box{max-width:620px;background:#16221d;border:1px solid #3a493f;border-radius:22px;padding:38px;text-align:center}h1{color:#d7b36a}p{line-height:1.6}a{color:#d7b36a}</style><div class="box"><h1>${content[0]}</h1><p>${content[1]}</p><p><a href="https://www.reivilo.com.br">Voltar ao site REIVILO</a></p></div></html>`);
});
module.exports = router;
