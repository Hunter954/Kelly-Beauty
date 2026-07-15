-- Valores operacionais iniciais para permitir que a agenda funcione logo após o deploy.
-- Todos continuam editáveis no painel administrativo e só são aplicados quando a duração está vazia.
UPDATE services SET duration_minutes = 60 WHERE name = 'Cabeleireira' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 30 WHERE name = 'Design de sobrancelhas' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 60 WHERE name = 'Manicure' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 60 WHERE name = 'Pedicure' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 120 WHERE name = 'Extensão de cílios' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 45 WHERE name = 'Depilação' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 60 WHERE name = 'Spa dos pés' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 60 WHERE name = 'Massagem estética' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 60 WHERE name = 'Modelagem corporal' AND duration_minutes IS NULL;
UPDATE services SET duration_minutes = 60 WHERE name = 'Massagem relaxante' AND duration_minutes IS NULL;

-- Garante que a profissional principal esteja vinculada aos serviços existentes.
INSERT INTO professional_services (professional_id, service_id)
SELECT p.id, s.id
FROM professionals p
CROSS JOIN services s
WHERE p.is_primary = TRUE AND p.active = TRUE AND s.active = TRUE
ON CONFLICT DO NOTHING;
