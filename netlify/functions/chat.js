const https = require('https');
 
exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
 
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
    }
 
    try {
        const { messages, userContext } = JSON.parse(event.body);
 
        const systemPrompt = `És a Hyybu, especialista pessoal de seguros da app Hyybu. 
Responde SEMPRE em português de Portugal.
Tom: amigável, próximo, simples — como um amigo que percebe de seguros.
Respostas curtas e diretas (máx 3 parágrafos).
Usa os dados do utilizador quando relevante: ${JSON.stringify(userContext || {})}.
Nunca digas que és Claude ou que és feito pela Anthropic.
Nunca recomendas seguradoras específicas.
Usa no máximo 2 emojis por resposta.`;
 
        const requestBody = JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages
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
 
        if (!data.content || !data.content[0]) {
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Resposta inválida da API' })
            };
        }
 
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ message: data.content[0].text })
        };
 
    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Erro técnico: ' + error.message })
        };
    }
};
 
