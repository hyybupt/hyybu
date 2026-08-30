const https = require('https');
const { getStore } = require('@netlify/blobs');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Limite diário GLOBAL de extrações (todos os utilizadores juntos). É a trava real de
// custo — funciona mesmo que alguém limpe o localStorage ou desative o limite do browser.
// Ajusta este número consoante o orçamento que quiseres arriscar por dia.
const DAILY_LIMIT_GLOBAL = 300;

function todayKey() {
    return new Date().toISOString().split('T')[0]; // AAAA-MM-DD (UTC)
}

async function checkAndIncrementDailyUsage() {
    const store = getStore('extract-usage');
    const key = todayKey();
    let count = 0;
    try {
        const raw = await store.get(key);
        count = raw ? parseInt(raw, 10) || 0 : 0;
    } catch (e) {
        // Se o Blobs falhar por qualquer razão, não bloqueamos o utilizador por causa disso —
        // preferimos falhar aberto (deixar passar) a partir a funcionalidade toda.
        return { allowed: true, count: 0 };
    }
    if (count >= DAILY_LIMIT_GLOBAL) {
        return { allowed: false, count };
    }
    try {
        await store.set(key, String(count + 1));
    } catch (e) {}
    return { allowed: true, count: count + 1 };
}

const SYSTEM_PROMPT = `És um extrator de dados especializado em apólices de seguro automóvel portuguesas.
Vais receber um documento (PDF ou fotografia) de "Condições Particulares" de uma apólice de seguro
automóvel e deves devolver APENAS um JSON estruturado, sem texto antes ou depois, sem markdown fences.

ÂMBITO: só interessam garantias, franquias, vencimento, dados do veículo e dados do tomador. Valores de
prémio estão explicitamente FORA do âmbito e nunca devem ser extraídos.

PRINCÍPIO FUNDAMENTAL — três camadas de exigência diferente:
1. indice_garantias: CRÍTICO. As 10 flags (rc_obrigatoria, assistencia_viagem, protecao_juridica,
   protecao_ocupantes, quebra_vidros, furto_roubo, incendio_raio_explosao, fenomenos_natureza,
   choque_colisao_capotamento, atos_vandalismo) têm de vir SEMPRE preenchidas com true ou false, nunca
   null. Se não encontrares a cobertura no documento, o valor é false — não é um campo em falta, é uma
   garantia que a pessoa não tem. A maioria das apólices reais NÃO tem todas as garantias; é normal e
   esperado que várias saiam false.
2. coberturas_detalhe: best-effort, só capitais e franquias das garantias já marcadas true no índice.
   Preenche o que encontrares; o resto fica null, sem penalizar a confiança geral.
3. conquistas_raras: só marca contratado=true quando a cobertura estiver explicitamente nomeada no
   documento com o seu próprio nome (ex: cães e gatos, bagagem, seguro de pneu, danos na roupa e
   calçado). Nunca inferir a partir de coberturas genéricas — um falso positivo aqui é pior do que não
   detetar.

GLOSSÁRIO DAS 10 FLAGS (variações de nome já vistas em 10 seguradoras portuguesas: Fidelidade, Una,
Divina, Generali/Tranquilidade, Allianz, Victoria, Ageas, Zurich, Mapfre, Lusitânia):
- rc_obrigatoria: "Responsabilidade Civil", "Responsabilidade Civil Obrigatória/Automóvel"
- assistencia_viagem: qualquer cobertura com "assistência" + "viagem" (VIP/Top/Plus)
- protecao_juridica: qualquer cobertura com "jurídica" (Proteção/Defesa e Proteção Jurídica)
- protecao_ocupantes: "Ocupantes", "Proteção do/ao Condutor", "Pessoas Transportadas",
  "Acidentes do Condutor/Segurado" — registar abrangencia "condutor" ou "todos"; acende com QUALQUER
  sub-cobertura (morte/invalidez, despesas tratamento, funeral)
- quebra_vidros: qualquer cobertura com "vidro(s)"
- furto_roubo: "Furto ou Roubo", "Furto e Roubo"
- incendio_raio_explosao: "Incêndio, Raio ou Explosão" — ATENÇÃO: a Zurich junta esta com Choque/Colisão
  numa linha só "Auto Proteção (Choque,Colis,Capotam,Inc)" — reconhecer e acender AMBAS as flags
  (incendio_raio_explosao e choque_colisao_capotamento) a partir dessa linha combinada
- fenomenos_natureza: "Fenómenos da Natureza", "Fenómenos Sísmicos", "Tempestades/Inundações/Granizo"
- choque_colisao_capotamento: "Choque, Colisão e/ou Capotamento"
- atos_vandalismo: "Atos de Vandalismo", "Riscos Sociais" (Ageas), ou combinada com greves/terrorismo
  ("Greves, Tumultos, Comoções Civis, Vandalismo e Atos de Terrorismo", "Vandalismo, Atos Maliciosos e
  Riscos Políticos", "Atos Terrorismo, Vandalismo, Sabotagem") — não confundir com uma linha separada de
  só "Greves/Tumultos/Alterações Ordem Pública" sem menção a vandalismo/atos maliciosos/terrorismo

REGRAS DE NORMALIZAÇÃO:
- Datas: devolver SEMPRE em formato ISO 8601 (AAAA-MM-DD), independentemente do formato no documento
  (ex: "21/04/2027" ou "21 de abril de 2027" -> "2027-04-21"). Se faltar o ano no documento, inferir o
  ano mais plausível a partir da data de início/duração da apólice e marcar confiança mais baixa.
- veiculo.data_matricula: data da primeira matrícula do veículo (não confundir com data de início da
  apólice) — costuma aparecer como "Data de Matrícula", "1ª Matrícula" ou implícita no ano do modelo.
  Se não encontrada, deixar null em vez de adivinhar a partir do ano do modelo.
- Franquia "Sem Franquia"/"Não Aplicável" -> franquia_eur = 0, nunca null.
- Franquia em percentagem (ex "2% mínimo 125€") -> registar como string em nota, não converter a euros.
- "Conforme Condição Especial"/"Conforme CE" -> contratado=true no índice, capital/franquia ficam null
  em coberturas_detalhe.
- "Capital Seguro" como valor de uma cobertura -> copiar de veiculo.valor_seguro_eur, origem "inferido".
- tomador.tipo: usar campo explícito da seguradora se existir (Tipo: Singular/Individual/Coletiva);
  senão inferir por forma jurídica no nome (Lda, S.A.) ou NIPC/NIF de pessoa coletiva.
- Documentos sem camada de texto (scan) -> ler diretamente da imagem, confiança um pouco mais baixa em
  campos numéricos ambíguos.
- Documentos longos com Condições Gerais anexadas -> focar nas primeiras páginas com "Condições
  Particulares", "Dados do Tomador", "Coberturas Contratadas".
- Ata Adicional/Duplicado/2ª Via/Estorno -> processar normalmente, contêm a tabela de coberturas válida.
- NUNCA extrair prémios (total, comercial, impostos, fracionamento) — estão FORA do âmbito e não devem
  aparecer no JSON. Nunca calcular/multiplicar/dividir valores monetários para derivar outros.
- NUNCA preencher indice_garantias por suposição sobre o nome do plano — só pela presença real da linha
  de cobertura no documento.

CONFIANÇA: cada campo folha é um objeto {valor, confianca (0-1), origem ("texto_pdf"|"ocr_visao"|
"inferido"), alerta (true se confianca<0.7)}. Nunca omitir um campo por baixa confiança — preencher com
o melhor palpite e marcar alerta=true.

FORMATO DE SAÍDA — devolve exatamente este JSON (sem markdown, sem comentários):
{
  "apolice": {"seguradora": {...}, "numero_apolice": {...}, "produto": {...}, "plano": {...},
    "data_inicio": {...}, "data_vencimento": {...}},
  "tomador": {"tipo": {...}, "nome": {...}, "nif_ou_nipc": {...}},
  "veiculo": {"matricula": {...}, "marca": {...}, "modelo": {...}, "data_matricula": {...},
    "valor_seguro_eur": {...}},
  "indice_garantias": {
    "rc_obrigatoria": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "assistencia_viagem": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "protecao_juridica": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "protecao_ocupantes": {"contratado": true/false, "abrangencia": "condutor"|"todos"|null,
      "confianca":..., "origem":..., "alerta":...},
    "quebra_vidros": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "furto_roubo": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "incendio_raio_explosao": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "fenomenos_natureza": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "choque_colisao_capotamento": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...},
    "atos_vandalismo": {"contratado": true/false, "confianca":..., "origem":..., "alerta":...}
  },
  "coberturas_detalhe": { ... livre, best-effort, valores null quando ausentes ... },
  "conquistas_raras": {
    "protecao_animais": {"contratado": true/false},
    "bagagem": {"contratado": true/false},
    "seguro_pneu": {"contratado": true/false},
    "danos_roupa_calcado": {"contratado": true/false}
  },
  "campos_para_confirmar": ["lista dos caminhos de campos com alerta=true"]
}`;

function translateApiError(err) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('password') || msg.includes('encrypted') || msg.includes('protected')) {
        return 'Este PDF está protegido por password. Remove a proteção (ou tira uma foto do documento) e tenta novamente.';
    }
    if (msg.includes('could not process') || msg.includes('unable to process') || msg.includes('invalid') && msg.includes('document')) {
        return 'Não conseguimos ler este documento — pode estar corrompido, ser um scan de muito má qualidade, ou não ser realmente um PDF. Tenta uma foto nítida das páginas em vez disso.';
    }
    if (msg.includes('too large') || msg.includes('size limit') || err.type === 'request_too_large') {
        return 'O ficheiro é demasiado grande. Tenta comprimir o PDF ou enviar uma foto em vez do documento completo.';
    }
    if (err.type === 'overloaded_error') {
        return 'O serviço está momentaneamente sobrecarregado. Tenta novamente daqui a um minuto.';
    }
    if (err.type === 'rate_limit_error') {
        return 'Estamos a receber muitos pedidos neste momento. Tenta novamente dentro de instantes.';
    }
    return 'Não foi possível analisar este documento. Tenta novamente ou usa uma foto nítida das Condições Particulares.';
}

exports.handler = async function (event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'API key not configured' }) };
    }

    const usage = await checkAndIncrementDailyUsage();
    if (!usage.allowed) {
        return {
            statusCode: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Atingimos o limite de análises de hoje — a procura foi maior do que o esperado! Tenta novamente amanhã, ou preenche as coberturas manualmente por agora.' })
        };
    }

    try {
        const { fileBase64, mediaType } = JSON.parse(event.body);

        if (!fileBase64 || !mediaType) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Ficheiro em falta' }) };
        }

        const isPdf = mediaType === 'application/pdf';
        const contentBlock = isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
            : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };

        const requestBody = JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [{
                role: 'user',
                content: [
                    contentBlock,
                    { type: 'text', text: 'Extrai os dados desta apólice seguindo exatamente o formato definido. Devolve só o JSON.' }
                ]
            }]
        });

        const response = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
            });

            req.on('error', reject);
            req.write(requestBody);
            req.end();
        });

        const data = JSON.parse(response.body);

        if (data.error && data.error.type) {
            return {
                statusCode: 200,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: translateApiError(data.error) })
            };
        }

        if (!data.content || !data.content[0]) {
            return {
                statusCode: 500,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: 'Resposta inválida da API' })
            };
        }

        const textBlocks = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        const clean = textBlocks.replace(/```json|```/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(clean);
        } catch (e) {
            return {
                statusCode: 200,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'O modelo não devolveu JSON válido. Tenta novamente.' })
            };
        }

        return {
            statusCode: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ result: parsed })
        };

    } catch (error) {
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: 'Erro técnico: ' + error.message })
        };
    }
};
