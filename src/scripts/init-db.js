require('dotenv').config();
const { runMigrations, closePool } = require('../db');

runMigrations()
  .then(() => {
    console.log('Banco inicializado com sucesso.');
  })
  .catch((error) => {
    console.error('Erro ao inicializar banco:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
