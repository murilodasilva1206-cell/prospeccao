-- ---------------------------------------------------------------------------
-- Migration 011: CNAE dictionary for dynamic nicho resolution
--
-- Allows the AI agent to resolve business-niche free-text ("dentistas") to
-- a CNAE principal code by querying this table first, with the static
-- NICHO_CNAE_MAP in lib/nicho-cnae.ts as a fallback.
--
-- Columns:
--   codigo    — CNAE principal code (PK), e.g. '8630-5/04'
--   descricao — Official Receita Federal description (for fuzzy ILIKE match)
--   sinonimos — Curated list of common synonyms / popular names (exact match)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cnae_dictionary (
  codigo    TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  sinonimos TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_cnae_dictionary_sinonimos
  ON cnae_dictionary USING GIN (sinonimos);

-- ---------------------------------------------------------------------------
-- Seed data — sourced from the static NICHO_CNAE_MAP (lib/nicho-cnae.ts),
-- grouped by CNAE code so synonyms are co-located.
-- ---------------------------------------------------------------------------

INSERT INTO cnae_dictionary (codigo, descricao, sinonimos) VALUES
  ('8630-5/04', 'Atividades Odontologicas',
   ARRAY['clinicas odontologicas','clinicas dentarias','dentistas','odontologia']),
  ('8630-5/01', 'Atividades de Atencao Ambulatorial Executadas por Medicos',
   ARRAY['clinicas medicas','medicos']),
  ('8610-1/01', 'Atividades de Atencao a Saude Humana - Hospitais',
   ARRAY['hospitais']),
  ('4771-7/01', 'Comercio Varejista de Produtos Farmaceuticos',
   ARRAY['farmacias','drogarias']),
  ('8640-2/02', 'Laboratorios Clinicos',
   ARRAY['laboratorios']),
  ('8650-0/05', 'Atividades de Fisioterapia',
   ARRAY['fisioterapia']),
  ('8650-0/06', 'Atividades de Psicologia e Psicanalise',
   ARRAY['psicologia']),
  ('8650-0/03', 'Atividades de Nutricao',
   ARRAY['nutricao']),
  ('7500-1/00', 'Atividades Veterinarias',
   ARRAY['veterinaria']),
  ('4789-0/04', 'Comercio Varejista de Animais Vivos e Artigos para Animais de Estimacao',
   ARRAY['petshop']),

  -- Alimentacao
  ('5611-2/01', 'Restaurantes e Similares',
   ARRAY['restaurantes','pizzarias','delivery']),
  ('5611-2/03', 'Lanchonetes, Casas de Cha, de Suco e Similares',
   ARRAY['lanchonetes','sorveterias','cafeterias']),
  ('5611-2/04', 'Bares e Estabelecimentos Especializados em Servicos de Bebidas',
   ARRAY['bares']),
  ('1091-1/02', 'Fabricacao de Produtos de Padaria e Confeitaria',
   ARRAY['padarias']),

  -- Beleza e Estetica
  ('9602-5/01', 'Cabeleireiros, Manicures e Pedicures',
   ARRAY['saloes de beleza','cabeleireiros','manicure']),
  ('9602-5/02', 'Barbearias',
   ARRAY['barbearias']),
  ('9602-5/03', 'Servicos de Estetica e Cuidados com a Beleza',
   ARRAY['estetica']),
  ('9609-2/08', 'Higiene e Embalsamento',
   ARRAY['spa']),

  -- Fitness e Bem-Estar
  ('9313-1/00', 'Atividades de Condicionamento Fisico',
   ARRAY['academias','pilates','crossfit','yoga']),

  -- Educacao
  ('8511-2/00', 'Educacao Infantil - Creches e Pre-Escolas',
   ARRAY['escolas','creches']),
  ('8532-5/00', 'Educacao Superior - Graduacao e Pos-Graduacao',
   ARRAY['faculdades']),
  ('8599-6/04', 'Treinamento em Desenvolvimento Profissional e Gerencial',
   ARRAY['cursos','cursinhos','idiomas']),

  -- Tecnologia
  ('6201-5/01', 'Desenvolvimento de Programas de Computador sob Encomenda',
   ARRAY['software','startups','desenvolvimento web']),
  ('6204-0/00', 'Consultoria em Tecnologia da Informacao',
   ARRAY['consultoria ti']),
  ('4791-0/02', 'Comercio Varejista pela Internet',
   ARRAY['ecommerce']),

  -- Varejo
  ('4781-4/00', 'Comercio Varejista de Artigos do Vestuario e Acessorios',
   ARRAY['lojas de roupas','moda']),
  ('4782-2/01', 'Comercio Varejista de Calcados',
   ARRAY['calcados']),
  ('4754-7/01', 'Comercio Varejista de Moveis',
   ARRAY['moveis']),
  ('4752-1/00', 'Comercio Varejista de Equipamentos de Telefonia e Comunicacao',
   ARRAY['eletronicos']),

  -- Construcao e Imoveis
  ('4120-4/00', 'Construcao de Edificios',
   ARRAY['construtoras']),
  ('6821-8/02', 'Corretagem na Compra e Venda e Avaliacao de Imoveis',
   ARRAY['imobiliarias']),
  ('7111-1/00', 'Servicos de Arquitetura',
   ARRAY['arquitetura']),
  ('7112-0/00', 'Servicos de Engenharia',
   ARRAY['engenharia']),

  -- Servicos
  ('6920-6/01', 'Atividades de Contabilidade',
   ARRAY['contabilidade']),
  ('6911-7/01', 'Servicos de Advocacia',
   ARRAY['advocacia']),
  ('7319-0/02', 'Promocao de Vendas',
   ARRAY['marketing']),
  ('4930-2/01', 'Transporte Rodoviario de Carga',
   ARRAY['logistica']),
  ('4921-3/02', 'Transporte Coletivo de Passageiros',
   ARRAY['transportes']),
  ('8011-1/01', 'Vigilancia e Seguranca Privada',
   ARRAY['seguranca']),
  ('8121-4/00', 'Limpeza em Predios e em Outros Estabelecimentos',
   ARRAY['limpeza']),

  -- Automotivo
  ('4520-0/01', 'Servicos de Manutencao e Reparacao Mecanica de Veiculos Automotores',
   ARRAY['oficinas']),
  ('4511-1/01', 'Comercio a Varejo de Automoveis, Camionetas e Utilitarios Novos',
   ARRAY['concessionarias']),
  ('4530-7/03', 'Comercio a Varejo de Pecas e Acessorios Novos para Veiculos Automotores',
   ARRAY['auto pecas'])

ON CONFLICT (codigo) DO UPDATE
  SET descricao = EXCLUDED.descricao,
      sinonimos = EXCLUDED.sinonimos;
