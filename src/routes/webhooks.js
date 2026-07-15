const express = require('express');
const { validateWebhookSignature, handlePaymentNotification } = require('../mercadopago');
const router = express.Router();

router.post('/mercadopago', async (req, res) => {
  try {
    if (!validateWebhookSignature(req)) return res.status(401).json({ ok: false, error: 'Assinatura inválida.' });
    const type = req.body?.type || req.query?.type;
    const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
    res.status(200).json({ ok: true });
    if ((type === 'payment' || !type) && paymentId) {
      handlePaymentNotification(paymentId).catch(error => console.error('Erro processando webhook Mercado Pago:', error));
    }
  } catch (error) {
    console.error('Webhook Mercado Pago:', error);
    if (!res.headersSent) res.status(500).json({ ok: false });
  }
});
module.exports = router;
