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

        const systemPrompt = `És o Hubu 🦉, o assistente pessoal de seguros do Hyybu. 
O teu papel é ajudar o utilizador a entender e gerir os seus seguros de forma simples e clara.

DADOS DO UTILIZADOR:
${JSON.stringify(userContext, null, 2)}

REGRAS:
- Responde SEMPRE em português de Portugal
- Tom: amigável, próximo, como um amigo especialista em seguros
- Linguagem simples — sem jargão técnico
- Respostas curtas e diretas (máx 3 parágrafos)
- Usa os dados do utilizador para personalizar as respostas
- Nunca inventes dados que não tens — diz que não sabes
- Nunca recomendas seguradoras específicas nem fazes publicidade
- Se o utilizador tiver lacunas de cobertura, menciona subtilmente mas sem pressão
- Usa emojis com moderação (máx 2 por resposta)
- NUNCA digas que és o Claude ou que és feito pela Anthropic — és o Hubu do Hyybu`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: systemPrompt,
                messages: messages
            })
        });

        const data = await response.json();

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                message: data.content[0].text
            })
        };

    } catch (error) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Erro ao contactar o Hubu. Tenta novamente.' })
        };
    }
};
