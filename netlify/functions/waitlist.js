const https = require('https');
const { getStore } = require('@netlify/blobs');

// Esta função guarda APENAS o email de quem se inscreve na lista de espera.
// Nunca recebe nem guarda qualquer dado de apólices — isso continua a viver
// só no dispositivo da pessoa, como sempre.

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const FROM_EMAIL = 'hyybu <ola@hyybu.pt>'; // tem de ser um domínio verificado no Resend

function isValidEmail(email) {
    return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sendConfirmationEmail(apiKey, to) {
    const body = JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject: 'Estás na lista — hyybu.',
        html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0D0D0D;">
                <div style="font-size:26px;font-weight:900;color:#1E6B8C;letter-spacing:-1.5px;margin-bottom:16px;">hyybu<span style="color:#0D0D0D;">.</span></div>
                <h2 style="color:#0D0D0D;font-size:20px;">Ficaste na lista! 🎉</h2>
                <p>Obrigado por te inscreveres. Vamos avisar-te por aqui assim que a app estiver disponível — não precisas de fazer mais nada.</p>
                <p style="color:#6B7280;font-size:13px;margin-top:24px;">Sem spam. Só te vamos escrever quando houver mesmo novidades sobre o lançamento.</p>
                <p style="font-size:12px;color:#9CA3AF;margin-top:32px;">Recebeste este email porque te inscreveste em hyybu.pt. Se não foste tu, podes ignorar esta mensagem.</p>
            </div>`
    });

    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.resend.com',
            path: '/emails',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

exports.handler = async function (event, context) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
    }

    let email;
    try {
        ({ email } = JSON.parse(event.body));
    } catch (e) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Pedido inválido' }) };
    }

    if (!isValidEmail(email)) {
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Email inválido' }) };
    }

    const key = email.toLowerCase().trim();
    const store = getStore('waitlist');
    const now = new Date().toISOString();

    let alreadyExists = false;
    try {
        const existing = await store.get(key);
        alreadyExists = !!existing;
    } catch (e) {
        // se o Blobs falhar a ler, seguimos como se fosse novo registo — não bloqueia a inscrição
    }

    try {
        await store.set(key, JSON.stringify({ email: key, registeredAt: now }));
    } catch (e) {
        console.error('Falha ao guardar email na lista de espera:', e);
        return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Não foi possível guardar o pedido. Tenta novamente.' }) };
    }

    // Envia email de confirmação (não bloqueia a resposta de sucesso se falhar —
    // a pessoa já está garantidamente guardada na lista mesmo que o email de
    // confirmação não chegue por algum problema pontual do Resend)
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey && !alreadyExists) {
        try {
            await sendConfirmationEmail(resendKey, key);
        } catch (e) {
            console.error('Falha ao enviar email de confirmação:', e);
        }
    }

    return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, alreadyExists })
    };
};
