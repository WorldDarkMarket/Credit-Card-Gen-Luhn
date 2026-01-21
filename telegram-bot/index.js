// redeploy trigger - comment update
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { isValidBin, generateCard, generateTempMail, checkTempMail, checkIP } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuração
// Use BOT_TOKEN from environment only. Do NOT hardcode tokens in source.
const BOT_TOKEN = process.env.BOT_TOKEN;
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

if (!BOT_TOKEN && !DRY_RUN) {
    console.error('Erro: BOT_TOKEN deve ser definido nas variáveis de ambiente (ou ativar DRY_RUN para teste local)');
    process.exit(1);
}

// If DRY_RUN is enabled we create a minimal bot-like object that logs calls
let bot;
if (DRY_RUN) {
    console.log('Iniciando em modo DRY_RUN: o bot não conectará à API do Telegram');
    // Minimal stub that supports used methods in this file
    bot = {
        use: () => {},
        command: () => {},
        hears: () => {},
        on: () => {},
        launch: async () => { console.log('DRY_RUN: bot.launch() called'); },
        stop: async () => { console.log('DRY_RUN: bot.stop() called'); },
        catch: () => {}
    };
} else {
    const { Telegraf } = await import('telegraf');
    bot = new Telegraf(BOT_TOKEN);
}

// Rate limiting and command debouncing
const userStates = new Map();
const COOLDOWN_PERIOD = 2000; // 2 seconds cooldown between commands
const processingCommands = new Set(); // Track commands being processed

const isCommandAllowed = (userId) => {
    const now = Date.now();
    const lastCommandTime = userStates.get(userId);
    
    if (!lastCommandTime || (now - lastCommandTime) >= COOLDOWN_PERIOD) {
        userStates.set(userId, now);
        return true;
    }
    return false;
};

// Middleware para rate limiting e prevenção de duplicados
bot.use(async (ctx, next) => {
    if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
        const userId = ctx.from.id;
        const messageId = ctx.message.message_id;
        const commandKey = `${userId}_${messageId}_slash`;
        
        // Se o comando já estiver sendo processado, ignorar
        if (processingCommands.has(commandKey)) {
            console.log(`Comando com / duplicado ignorado: ${commandKey}`);
            return;
        }
        
        // Se o usuário estiver em cooldown, ignorar o comando
        if (!isCommandAllowed(userId)) {
            console.log(`Comando com / ignorado por cooldown: ${commandKey}`);
            await ctx.reply('⚠️ Por favor, aguarde alguns segundos antes de usar outro comando.');
            return;
        }
        
        // Marcar o comando como em processamento
        processingCommands.add(commandKey);
        
        try {
            await next();
        } finally {
            // Limpar após um tempo
            setTimeout(() => {
                processingCommands.delete(commandKey);
            }, 60000);
        }
    } else {
        await next();
    }
});

// Diretório de dados
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Funções de utilidade
const getUserDataPath = (userId) => path.join(DATA_DIR, `${userId}.json`);

const loadUserData = (userId) => {
    const filePath = getUserDataPath(userId);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    return {
        favorites: [],
        history: [],
        tempMail: null
    };
};

const saveUserData = (userId, data) => {
    const filePath = getUserDataPath(userId);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
};

// Função para consultar BIN usando APIs alternativas
const lookupBin = async (bin) => {
    try {
        console.log(`Consultando BIN ${bin} em binlist.net...`);
        // Primeira API: binlist.net
        const response1 = await fetch(`https://lookup.binlist.net/${bin}`);
        if (response1.ok) {
            const data1 = await response1.json();
            console.log('Resposta de binlist.net:', data1);
            return {
                bank: data1.bank?.name || 'Desconhecido',
                brand: data1.scheme || 'Desconhecida',
                type: data1.type || 'Desconhecido',
                country: data1.country?.name || 'Desconhecido',
                countryCode: data1.country?.alpha2 || '??',
                level: data1.brand || 'Desconhecido'
            };
        }
        console.log(`binlist.net falhou com status ${response1.status}`);

        console.log(`Consultando BIN ${bin} em bintable.com...`);
        // Segunda API: bintable.com
        const response2 = await fetch(`https://api.bintable.com/v1/${bin}?api_key=19d935a6d3244f3f8bab8f09157e4936`);
        if (response2.ok) {
            const data2 = await response2.json();
            console.log('Resposta de bintable.com:', data2);
            return {
                bank: data2.bank?.name || 'Desconhecido',
                brand: data2.scheme || data2.brand || 'Desconhecida',
                type: data2.type || 'Desconhecido',
                country: data2.country?.name || 'Desconhecido',
                countryCode: data2.country?.code || '??',
                level: data2.level || 'Desconhecido'
            };
        }
        console.log(`bintable.com falhou com status ${response2.status}`);

        throw new Error('Não foi possível obter informações do BIN');
    } catch (error) {
        console.error('Erro ao consultar BIN:', error);
        return null;
    }
};

// Função para registrar comandos com ambos prefixos
const registerCommand = (command, handler) => {
    // Registrar com prefixo /
    bot.command(command, handler);
    // Registrar com prefixo . usando regex insensível a maiúsculas
    bot.hears(new RegExp(`^\\.${command}\\b`, 'i'), handler);
};

// Função para extrair argumentos da mensagem
const getCommandArgs = (ctx) => {
    const text = ctx.message.text;
    // Se o comando começa com /, usar split normal
    if (text.startsWith('/')) {
        return text.split(' ').slice(1).join(' ');
    }
    // Se o comando começa com ., extrair tudo após o comando
    const match = text.match(/^\.(\w+)\s*(.*)/);
    if (match) {
        return match[2];
    }
    return '';
};

// Função para gerar mensagem de limpeza
const generateClearMessage = () => {
    return '⠀\n'.repeat(100) + '🧹 Chat limpo';
};

// Função robusta para parsear o input do comando gen
function parseGenInput(input) {
    // Remover espaços no início e fim
    input = input.trim();
    // Substituir múltiplos separadores por um único
    input = input.replace(/\|/g, ' ').replace(/\s+/g, ' ');
    // Remover caracteres x ou X no final do bin
    let [bin, month, year, cvv] = input.split(' ');
    if (bin) bin = bin.replace(/x+$/i, '');
    // Se o mês e ano vierem juntos (ex: 06/25 ou 06/2025)
    if (month && /\//.test(month)) {
        const [m, y] = month.split('/');
        month = m;
        year = y && y.length === 2 ? '20' + y : y;
    }
    // Se o ano for de 2 dígitos, converter para 4
    if (year && year.length === 2) year = '20' + year;
    // Se o mês for inválido mas o ano parece mês (ex: 2025 06)
    if (year && month && month.length === 4 && /^20[2-3][0-9]$/.test(month) && /^0[1-9]|1[0-2]$/.test(year)) {
        [month, year] = [year, month];
    }
    // Se o cvv contiver x, ignorar
    if (cvv && /x/i.test(cvv)) cvv = undefined;
    return { bin, month, year, cvv };
}

// Função para processar comandos com ponto
const handleDotCommand = async (ctx) => {
    const text = ctx.message.text;
    if (!text.startsWith('.')) return false;

    // Extrair o comando e os argumentos
    const match = text.match(/^\.(\w+)\s*(.*)/);
    if (!match) return false;

    const [, command, args] = match;
    console.log('Comando com ponto detectado:', { command, args });

    switch (command.toLowerCase()) {
        case 'clear':
        case 'limpar':
            await ctx.reply(generateClearMessage());
            return true;

        case 'gen':
            if (!args) {
                await ctx.reply('❌ Uso: .gen BIN|MM|YYYY|CVV\nExemplo: .gen 477349002646|05|2027|123');
                return true;
            }
            // Usar o novo parser
            const { bin, month: fixedMonth, year: fixedYear, cvv: fixedCVV } = parseGenInput(args);
            if (!isValidBin(bin)) {
                await ctx.reply('❌ BIN inválido. Deve conter apenas números, entre 6 e 16 dígitos.');
                return true;
            }
            if (fixedMonth && !/^(0[1-9]|1[0-2])$/.test(fixedMonth)) {
                await ctx.reply('❌ Mês inválido. Deve estar entre 01 e 12.');
                return true;
            }
            if (fixedYear && !/^([0-9]{2}|20[2-3][0-9])$/.test(fixedYear)) {
                await ctx.reply('❌ Ano inválido. Deve estar no formato YY ou YYYY e ser maior que o ano atual.');
                return true;
            }
            if (fixedCVV && !/^[0-9]{3,4}$/.test(fixedCVV)) {
                await ctx.reply('❌ CVV inválido. Deve conter 3 ou 4 dígitos.');
                return true;
            }
            try {
                const cards = Array(10).fill().map(() => {
                    const card = generateCard(bin);
                    if (fixedMonth) card.month = fixedMonth;
                    if (fixedYear) card.year = fixedYear?.slice(-2) || card.year;
                    if (fixedCVV) card.cvv = fixedCVV;
                    return card;
                });
                const response = cards.map(card => 
                    `${card.number}|${card.month}|${card.year}|${card.cvv}`
                ).join('\n');
                // Salvar no histórico
                const userId = ctx.from.id;
                const userData = loadUserData(userId);
                userData.history.unshift({
                    type: 'gen',
                    bin,
                    count: cards.length,
                    timestamp: new Date().toISOString()
                });
                saveUserData(userId, userData);
                await ctx.reply(`🎲 Cartões gerados:\n\n${response}`);
            } catch (error) {
                console.error('Erro no comando .gen:', error);
                await ctx.reply(`❌ Erro ao gerar cartões: ${error.message}`);
            }
            return true;

        case 'bin':
            if (!args) {
                await ctx.reply('❌ Uso: .bin BIN\nExemplo: .bin 431940');
                return true;
            }
            if (!isValidBin(args)) {
                await ctx.reply('❌ BIN inválido. Deve conter apenas números, entre 6 e 16 dígitos.');
                return true;
            }
            try {
                const binInfo = await lookupBin(args);
                if (!binInfo) {
                    await ctx.reply('❌ Não foram encontradas informações para este BIN');
                    return true;
                }

                const response = `
🔍 Informações do BIN: ${args}

🏦 Banco: ${binInfo.bank}
💳 Bandeira: ${binInfo.brand}
🌍 País: ${binInfo.country} (${binInfo.countryCode})
📱 Tipo: ${binInfo.type}
⭐️ Nível: ${binInfo.level}
                `;

                // Salvar no histórico
                const userId = ctx.from.id;
                const userData = loadUserData(userId);
                userData.history.unshift({
                    type: 'lookup',
                    bin: args,
                    info: binInfo,
                    timestamp: new Date().toISOString()
                });
                saveUserData(userId, userData);

                await ctx.reply(response);
            } catch (error) {
                console.error('Erro no comando .bin:', error);
                await ctx.reply(`❌ Erro ao consultar BIN: ${error.message}`);
            }
            return true;

        case 'start':
        case 'ajuda':
        case 'help':
            const helpText = `👋 Olá! Bem-vindo ao CARD GEN PRO

Todos os comandos funcionam com / ou . (por exemplo, /gen ou .gen)

🔧 Geração de Cartões
gen BIN|MM|YYYY|CVV  
► Gera 10 cartões automaticamente  
Exemplo: gen 477349002646|05|2027|123

🔍 Consultas Inteligentes
bin BIN  
► Informações detalhadas de um BIN  
Exemplo: bin 431940

ip <endereço IP>  
► Consulta informações e risco de um IP  
Exemplo: ip 8.8.8.8

cedula <número de cédula>  
► Consulta dados SRI por cédula  
Exemplo: cedula 17xxxxxxxx

placa <número de placa>
► Consulta dados de veículo por placa
Exemplo: placa PDF9627

⭐️ Favoritos
favoritos  
► Lista seus BINs salvos

agregarbin BIN [mês] [ano] [cvv]  
► Salva um BIN para usar depois

eliminarbin <índice>  
► Remove um BIN da sua lista

📋 Utilidades
historial  
► Revise suas consultas anteriores

clear  
► Limpa o chat

ajuda  
► Mostra este guia de comandos

🌐 Teste também a versão web  
darklabs.codex.art

Tools Services by @Ghost00_Root | Powered by DarkLabs Projects`;
            await ctx.reply(helpText);
            return true;

        case 'favoritos':
            const userDataFav = loadUserData(ctx.from.id);
            if (userDataFav.favorites.length === 0) {
                await ctx.reply('📌 Você não tem BINs favoritos salvos');
                return true;
            }
            const responseFav = userDataFav.favorites.map((fav, index) => 
                `${index + 1}. ${fav.bin} (${fav.month || 'MM'}/${fav.year || 'YY'})`
            ).join('\n');
            await ctx.reply(`📌 Seus BINs favoritos:\n\n${responseFav}`);
            return true;

        case 'historial':
            const userDataHist = loadUserData(ctx.from.id);
            if (userDataHist.history.length === 0) {
                await ctx.reply('📝 Sem histórico de consultas');
                return true;
            }
            const responseHist = userDataHist.history.slice(0, 10).map((item, index) => {
                const date = new Date(item.timestamp).toLocaleString();
                if (item.type === 'gen') {
                    return `${index + 1}. Geração: ${item.bin} (${item.count} cartões) - ${date}`;
                } else {
                    return `${index + 1}. Consulta: ${item.bin} - ${date}`;
                }
            }).join('\n');
            await ctx.reply(`📝 Histórico recente:\n\n${responseHist}`);
            return true;

        case 'agregarbin':
            if (!args) {
                await ctx.reply('❌ Uso: .agregarbin BIN mês? ano? cvv?');
                return true;
            }
            // Usar o parser flexível
            const parsedAdd = parseGenInput(args);
            if (!isValidBin(parsedAdd.bin)) {
                await ctx.reply('❌ BIN inválido. Deve conter apenas números, entre 6 e 16 dígitos.');
                return true;
            }
            const userIdAdd = ctx.from.id;
            const userDataAdd = loadUserData(userIdAdd);
            if (userDataAdd.favorites.some(fav => fav.bin === parsedAdd.bin)) {
                await ctx.reply('❌ Este BIN já está nos seus favoritos');
                return true;
            }
            userDataAdd.favorites.push({ bin: parsedAdd.bin, month: parsedAdd.month, year: parsedAdd.year, cvv: parsedAdd.cvv });
            saveUserData(userIdAdd, userDataAdd);
            await ctx.reply('✅ BIN adicionado aos favoritos');
            return true;

        case 'eliminarbin':
            if (!args) {
                await ctx.reply('❌ Uso: .eliminarbin índice ou BIN');
                return true;
            }
            const userIdDel = ctx.from.id;
            const userDataDel = loadUserData(userIdDel);
            // Se for número, remover por índice
            if (/^\d+$/.test(args)) {
                const index = parseInt(args) - 1;
                if (isNaN(index) || index < 0 || index >= userDataDel.favorites.length) {
                    await ctx.reply('❌ Índice inválido');
                    return true;
                }
                const removedBin = userDataDel.favorites.splice(index, 1)[0];
                saveUserData(userIdDel, userDataDel);
                await ctx.reply(`✅ BIN ${removedBin.bin} removido dos favoritos`);
                return true;
            }
            // Se for BIN flexível, usar o parser
            const parsedDel = parseGenInput(args);
            const favIndex = userDataDel.favorites.findIndex(fav => fav.bin === parsedDel.bin);
            if (favIndex === -1) {
                await ctx.reply('❌ BIN não encontrado nos seus favoritos');
                return true;
            }
            const removedBin = userDataDel.favorites.splice(favIndex, 1)[0];
            saveUserData(userIdDel, userDataDel);
            await ctx.reply(`✅ BIN ${removedBin.bin} removido dos favoritos`);
            return true;

        case 'mail':
            await handleMailCommand(ctx);
            return true;

        case 'check':
            await handleCheckCommand(ctx);
            return true;

        case 'ip':
            await handleIPCommand(ctx);
            return true;
    }
    return false;
};

// Middleware para comandos com ponto
bot.on('text', async (ctx, next) => {
    try {
        if (ctx.message.text.startsWith('.')) {
            const userId = ctx.from.id;
            const messageId = ctx.message.message_id;
            const commandKey = `${userId}_${messageId}_dot`;
            
            // Se o usuário estiver em cooldown, ignorar o comando
            if (!isCommandAllowed(userId)) {
                console.log(`Comando com . ignorado por cooldown: ${commandKey}`);
                await ctx.reply('⚠️ Por favor, aguarde alguns segundos antes de usar outro comando.');
                return;
            }
            
            console.log(`Processando comando com ponto: ${ctx.message.text}`);
            const handled = await handleDotCommand(ctx);
            if (!handled) {
                await next();
            }
        } else {
            await next();
        }
    } catch (error) {
        console.error('Erro no middleware de texto:', error);
    }
});

// URL da imagem oficial (Atualizada)
const HACKER_IMG_URL = 'https://files.catbox.moe/t13e9e.jpg';

const toolsBlock = `🛠 Ferramentas disponíveis:

Geração e Consultas:
• /gen BIN|MM|YYYY|CVV - Gera cartões 💳
• /bin BIN - Consulta BIN 🔍
• /ip <IP> - Consulta IP e risco 🌐
• /cedula <número> - Consulta SRI por cédula 🪪
• /placa <número> - Consulta dados de veículo 🚗

Email Temporário:
• /mail - Gera email temporário 📧
• /check - Verifica mensagens do email 📨

Favoritos:
• /favoritos - Seus BINs favoritos ⭐️
• /agregarbin BIN mês ano cvv - Adiciona BIN aos favoritos ➕
• /eliminarbin <índice> - Remove BIN dos favoritos 🗑

Utilidades:
• /historial - Seu histórico 📝
• /clear - Limpar chat 🧹

Todos os comandos funcionam com / ou .`;

// Comandos do bot
registerCommand('start', async (ctx) => {
    const warning = '⚡️ <b>ATENÇÃO!</b> Este Projeto não é uma Simulação';
    const desc = '<i>Bem-vindo ao laboratório virtual de cartões e OSINT. Apenas para hackers éticos, pentesters e mentes curiosas. O uso indevido das informações geradas pode ter consequências legais. Explore por seu próprio risco! 👾</i>';
    const welcome = '<b>DarkGenCards BOT</b>\n';
    await ctx.replyWithPhoto(HACKER_IMG_URL, {
        caption: `${warning}\n\n${welcome}\n${desc}`,
        parse_mode: 'HTML'
    });
    await ctx.reply(toolsBlock);
    await ctx.reply('Selecione uma opção do menu:', {
        reply_markup: {
            keyboard: [
                ['🛠 Tools', '👤 Creator'],
                ['💸 Donate', '🌐 Web']
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// Handlers para os botões do menu principal
bot.hears('🛠 Tools', (ctx) => {
    ctx.reply(toolsBlock);
});
bot.hears('👤 Creator', (ctx) => {
    ctx.reply('👤 Criador: @Ghost00_Root\nhttps://t.me/Ghost00_Root');
});
bot.hears('💸 Donate', (ctx) => {
    ctx.reply('💸 Doações → @Ghost00_Root');
});
bot.hears('🌐 Web', (ctx) => {
    ctx.reply('🌐 Web: darklabs.codex.art\nhttps://darklabs.codex.art');
});

registerCommand('help', (ctx) => {
    ctx.reply(toolsBlock);
});

registerCommand('ajuda', (ctx) => {
    ctx.reply(toolsBlock);
});

registerCommand('gen', async (ctx) => {
    const messageId = ctx.message.message_id;
    console.log(`Processando comando gen, messageId: ${messageId}`);
    try {
        const input = getCommandArgs(ctx);
        console.log('Input completo:', ctx.message.text);
        console.log('Input processado:', input);
        if (!input) {
            return ctx.reply('❌ Uso: /gen ou .gen BIN|MM|YYYY|CVV\nExemplo: /gen 477349002646|05|2027|123');
        }
        // Usar o novo parser
        const { bin, month: fixedMonth, year: fixedYear, cvv: fixedCVV } = parseGenInput(input);
        console.log('Parseado:', { bin, fixedMonth, fixedYear, fixedCVV });
        if (!isValidBin(bin)) {
            return ctx.reply('❌ BIN inválido. Deve conter apenas números, entre 6 e 16 dígitos.');
        }
        if (fixedMonth && !/^(0[1-9]|1[0-2])$/.test(fixedMonth)) {
            return ctx.reply('❌ Mês inválido. Deve estar entre 01 e 12.');
        }
        if (fixedYear && !/^([0-9]{2}|20[2-3][0-9])$/.test(fixedYear)) {
            return ctx.reply('❌ Ano inválido. Deve estar no formato YY ou YYYY e ser maior que o ano atual.');
        }
        if (fixedCVV && !/^[0-9]{3,4}$/.test(fixedCVV)) {
            return ctx.reply('❌ CVV inválido. Deve conter 3 ou 4 dígitos.');
        }
        const cards = Array(10).fill().map(() => {
            const card = generateCard(bin);
            if (fixedMonth) card.month = fixedMonth;
            if (fixedYear) card.year = fixedYear?.slice(-2) || card.year;
            if (fixedCVV) card.cvv = fixedCVV;
            return card;
        });
        let binInfo = await lookupBin(bin.slice(0, 6));
        if (!binInfo) binInfo = {};
        const bank = binInfo.bank || 'Não disponível';
        const brand = binInfo.brand || 'Não disponível';
        const country = binInfo.country || 'Não disponível';
        const countryCode = binInfo.countryCode || '';
        const type = binInfo.type || 'Não disponível';
        const level = binInfo.level || 'Não disponível';
        const flag = countryCode ? String.fromCodePoint(...[...countryCode.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '';
        const userName = ctx.from.first_name || 'Usuário';
        const header = `\n𝘽𝙞𝙣 -» ${bin}xxxx|${fixedMonth || 'xx'}|${fixedYear ? fixedYear.slice(-2) : 'xx'}|${fixedCVV || 'rnd'}\n─━─━─━─━─━─━─━─━─━─━─━─━─`;
        const tarjetas = cards.map(card => `${card.number}|${card.month}|${card.year}|${card.cvv}`).join('\n');
        const cardBlock = tarjetas;
                const binInfoFormatted = `\n─━─━─━─━─━─━─━─━─━─━─━─━─\n• 𝙄𝙣𝙛𝙤 -» ${brand} - ${type} - ${level}\n• 𝘽𝙖𝙣𝙠 -» ${bank}\n• 𝘾𝙤𝙪𝙣𝙩𝙧𝙮 -» ${country} ${flag}\n─━─━─━─━─━─━─━─━─━─━─━─━─\n• 𝙂𝙚𝙣 𝙗𝙮 -» ${userName} -» @DarkGenCardsBot`;
        const response = `${header}\n${cardBlock}\n${binInfoFormatted}`;
        const userId = ctx.from.id;
        const userData = loadUserData(userId);
        userData.history.unshift({
            type: 'gen',
            bin,
            count: cards.length,
            timestamp: new Date().toISOString()
        });
        saveUserData(userId, userData);
        await ctx.reply(response);
    } catch (error) {
        console.error(`Erro no comando gen, messageId: ${messageId}:`, error);
        await ctx.reply(`❌ Erro ao gerar cartões: ${error.message}`);
    }
});

registerCommand('bin', async (ctx) => {
    try {
        const bin = getCommandArgs(ctx);
        console.log('Input completo:', ctx.message.text);
        console.log('BIN processado:', bin);
        
        if (!bin) {
            return ctx.reply('❌ Uso: /bin ou .bin BIN\nExemplo: /bin 431940');
        }

        if (!isValidBin(bin)) {
            return ctx.reply('❌ BIN inválido. Deve conter apenas números, entre 6 e 16 dígitos.');
        }

        const binInfo = await lookupBin(bin);
        if (!binInfo) {
            return ctx.reply('❌ Não foram encontradas informações para este BIN');
        }

        const response = `
🔍 Informações do BIN: ${bin}

🏦 Banco: ${binInfo.bank}
💳 Bandeira: ${binInfo.brand}
🌍 País: ${binInfo.country} (${binInfo.countryCode})
📱 Tipo: ${binInfo.type}
⭐️ Nível: ${binInfo.level}
        `;

        // Salvar no histórico
        const userId = ctx.from.id;
        const userData = loadUserData(userId);
        userData.history.unshift({
            type: 'lookup',
            bin,
            info: binInfo,
            timestamp: new Date().toISOString()
        });
        saveUserData(userId, userData);

        await ctx.reply(response);
    } catch (error) {
        console.error('Erro no comando bin:', error);
        await ctx.reply(`❌ Erro ao consultar BIN: ${error.message}`);
    }
});

registerCommand('favoritos', (ctx) => {
    const userId = ctx.from.id;
    const userData = loadUserData(userId);
    
    if (userData.favorites.length === 0) {
        return ctx.reply('📌 Você não tem BINs favoritos salvos');
    }

    const response = userData.favorites.map((fav, index) => 
        `${index + 1}. ${fav.bin} (${fav.month || 'MM'}/${fav.year || 'YY'})`
    ).join('\n');

    ctx.reply(`📌 Seus BINs favoritos:\n\n${response}`);
});

registerCommand('historial', (ctx) => {
    const userId = ctx.from.id;
    const userData = loadUserData(userId);
    
    if (userData.history.length === 0) {
        return ctx.reply('📝 Sem histórico de consultas');
    }

    const response = userData.history.slice(0, 10).map((item, index) => {
        const date = new Date(item.timestamp).toLocaleString();
        if (item.type === 'gen') {
            return `${index + 1}. Geração: ${item.bin} (${item.count} cartões) - ${date}`;
        } else {
            return `${index + 1}. Consulta: ${item.bin} - ${date}`;
        }
    }).join('\n');

    ctx.reply(`📝 Histórico recente:\n\n${response}`);
});

registerCommand('clear', async (ctx) => {
    await ctx.reply(generateClearMessage());
});

registerCommand('limpar', async (ctx) => {
    await ctx.reply(generateClearMessage());
});

registerCommand('cedula', async (ctx) => {
    const cedula = getCommandArgs(ctx).trim();
    if (!cedula || !/^[0-9]{10}$/.test(cedula)) {
        return ctx.reply('❌ Uso: /cedula <número de cédula>\nExemplo: /cedula 17xxxxxxxx');
    }
    try {
        // Melhor manejo: timeout, retries, e mensagens conforme status
        const buildUrl = () => `https://srienlinea.sri.gob.ec/movil-servicios/api/v1.0/deudas/porIdentificacion/${cedula}/?tipoPersona=N&_=${Date.now()}`;

        const fetchWithTimeout = async (resource, options = {}) => {
            const { timeout = 8000 } = options;
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeout);
            try {
                const resp = await fetch(resource, { ...options, signal: controller.signal });
                clearTimeout(id);
                return resp;
            } catch (err) {
                clearTimeout(id);
                throw err;
            }
        };

        // Tentar até 2 vezes em caso de falha transitória
        let resp; let data;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                resp = await fetchWithTimeout(buildUrl(), { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
                // Se recebermos 429 ou 5xx, retry mais uma vez com backoff
                if (resp.status === 429) {
                    if (attempt === 1) await new Promise(r => setTimeout(r, 1200));
                    else break;
                }
                if (resp.status >= 500 && resp.status < 600) {
                    if (attempt === 1) await new Promise(r => setTimeout(r, 800));
                    else break;
                }
                break;
            } catch (err) {
                if (attempt === 2) throw err;
                await new Promise(r => setTimeout(r, 700));
            }
        }

        if (!resp) throw new Error('No response from SRI');

        // Lidar com códigos HTTP comuns
        if (resp.status === 404) {
            return ctx.reply(`❌ Não foram encontradas informações para a cédula ${cedula}.`);
        }
        if (resp.status === 429) {
            return ctx.reply('⚠️ Serviço temporariamente sobrecarregado. Tente novamente em alguns segundos.');
        }
        if (resp.status >= 400) {
            console.error('SRI responded with status', resp.status);
            return ctx.reply('❌ Erro ao consultar a cédula. Tente mais tarde.');
        }

        // Analisar JSON de forma segura
        try {
            data = await resp.json();
        } catch (err) {
            console.error('Erro ao analisar resposta JSON do SRI:', err);
            return ctx.reply('❌ Resposta inesperada do serviço SRI. Tente mais tarde.');
        }

        if (data && data.contribuyente) {
            const info = data.contribuyente;
            let msg = `🪪 Informações SRI para a cédula: <code>${cedula}</code>\n\n`;
            msg += `• <b>Nome Comercial:</b> ${info.nombreComercial || info.denominacion || 'Não disponível'}\n`;
            msg += `• <b>Classe:</b> ${info.clase || 'Não disponível'}\n`;
            msg += `• <b>Tipo de Identificação:</b> ${info.tipoIdentificacion || 'Não disponível'}\n`;
            if (info.fechaInformacion) {
                try {
                    const date = new Date(Number(info.fechaInformacion));
                    if (!isNaN(date)) msg += `• <b>Data da Informação:</b> ${date.toLocaleString()}\n`;
                } catch (e) { /* ignore */ }
            }
            if (data.deuda) {
                msg += `\n💸 <b>Dívida:</b> ${data.deuda.estado || 'Não disponível'} - ${data.deuda.monto || 'Não disponível'}`;
            } else {
                msg += `\n💸 <b>Dívida:</b> Sem registro de dívida`;
            }
            await ctx.replyWithHTML(msg);
        } else {
            await ctx.reply('❌ Não foram encontradas informações para a cédula fornecida.');
        }
    } catch (error) {
        console.error('Erro no comando /cedula:', error);
        // Mensagem mais informativa para o usuário final
        if (error.name === 'AbortError') {
            await ctx.reply('⚠️ Tempo limite esgotado ao contatar o serviço SRI. Tente novamente.');
        } else {
            await ctx.reply('❌ Erro ao consultar a cédula. Tente mais tarde.');
        }
    }
});

// Função para consultar dados de placa de veículo
async function consultarPlaca(placa) {
    const url = `https://srienlinea.sri.gob.ec/movil-servicios/api/v1.0/matriculacion/valor/${placa}`;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Erro na consulta');
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Erro ao consultar a placa:', error);
        throw error;
    }
}

// Função para lidar com comandos do Telegram
function handleTelegramCommand(command, placa) {
    if (command === '.placa' || command === '/placa') {
        consultarPlaca(placa)
            .then(data => {
                console.log('Dados da placa:', data);
            })
            .catch(error => {
                console.error('Erro ao consultar a placa:', error);
            });
    } else if (command === '/start') {
        console.log('Bem-vindo ao bot de consulta de placas. Use .placa ou /placa seguido da placa para consultar.');
    } else if (command === '/help') {
        console.log('Comandos disponíveis:\n.placa [número de placa] - Consulta dados da placa\n/placa [número de placa] - Consulta dados da placa\n/start - Inicia o bot\n/help - Mostra esta mensagem de ajuda');
    }
}

// Registrar comando placa
registerCommand('placa', async (ctx) => {
    const placa = getCommandArgs(ctx).toUpperCase(); // Converter para maiúsculas
    if (!placa) {
        await ctx.reply('❌ Uso: .placa PLACA\nExemplo: .placa PDF9627');
        return;
    }

    try {
        const data = await consultarPlaca(placa);
        const mensagem = `
🚗 Informações do veículo: ${placa}

📝 Marca: ${data.marca}
🚙 Modelo: ${data.modelo}
📅 Ano: ${data.anioModelo}
🔧 Cilindrada: ${data.cilindraje}
🏭 País: ${data.paisFabricacion}
🚦 Classe: ${data.clase}
🔑 Serviço: ${data.servico}
💰 Total a pagar: $${data.total}

📍 Cantão: ${data.cantonMatricula}
📆 Última matrícula: ${new Date(data.fechaUltimaMatricula).toLocaleDateString()}
⏳ Validade: ${new Date(data.fechaCaducidadMatricula).toLocaleDateString()}
🔄 Estado: ${data.estadoAuto}
`;
        await ctx.reply(mensagem);
    } catch (error) {
        console.error('Erro ao consultar a placa:', error);
        await ctx.reply('❌ Erro ao consultar a placa. Por favor, verifique se a placa está correta.');
    }
});

// Função para lidar com o comando de email temporário
const handleMailCommand = async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userData = loadUserData(userId);
        
        // Enviar mensagem de espera
        const waitMsg = await ctx.reply('⏳ Gerando email temporário...');
        
        try {
            // Gerar novo email temporário
            const { email, token, password } = await generateTempMail();
            
            // Salvar o token e a senha nos dados do usuário
            userData.tempMail = { email, token, password };
            saveUserData(userId, userData);
            
            // Atualizar mensagem de espera com o email gerado
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `📧 *Email Temporário Gerado*\n\n` +
                `📨 *Email:* \`${email}\`\n` +
                `🔑 *Senha:* \`${password}\`\n\n` +
                `⚠️ Este email é temporário e será excluído automaticamente.\n` +
                `📝 Use \`.check\` para verificar se há novas mensagens.`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Erro no comando mail:', error);
            // Atualizar mensagem de espera com o erro
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `❌ Erro ao gerar o email temporário: ${error.message}\nPor favor, tente novamente.`
            );
        }
    } catch (error) {
        console.error('Erro geral no comando mail:', error);
        await ctx.reply('❌ Erro ao gerar o email temporário. Por favor, tente novamente.');
    }
};

// Função para verificar mensagens
const handleCheckCommand = async (ctx) => {
    try {
        const userId = ctx.from.id;
        const userData = loadUserData(userId);
        
        if (!userData.tempMail) {
            await ctx.reply('❌ Você não tem um email temporário ativo. Use \`.mail\` para gerar um.');
            return;
        }

        // Enviar mensagem de espera
        const waitMsg = await ctx.reply('⏳ Verificando mensagens...');
        
        try {
            const messages = await checkTempMail(userData.tempMail.token);
            
            if (!messages || messages.length === 0) {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    null,
                    `📭 Sem novas mensagens no email: ${userData.tempMail.email}`
                );
                return;
            }
            
            // Atualizar mensagem de espera
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `📨 Encontradas ${messages.length} mensagens em ${userData.tempMail.email}`
            );
            
            // Mostrar as mensagens
            for (const msg of messages) {
                try {
                    let messageText = `📨 *Nova mensagem recebida*\n\n`;
                    messageText += `*De:* ${msg.from?.address || 'Desconhecido'}\n`;
                    messageText += `*Para:* ${msg.to?.[0]?.address || userData.tempMail.email}\n`;
                    messageText += `*Assunto:* ${msg.subject || 'Sem assunto'}\n`;
                    messageText += `*Data:* ${new Date(msg.createdAt).toLocaleString()}\n\n`;
                    
                    let content = msg.text || msg.html || 'Sem conteúdo';
                    if (msg.html) {
                        content = content
                            .replace(/<[^>]*>/g, '')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'");
                    }
                    
                    if (content.length > 1000) {
                        content = content.substring(0, 1000) + '...\n(conteúdo truncado)';
                    }
                    
                    messageText += `*Conteúdo:*\n${content}\n`;
                    
                    await ctx.reply(messageText, { 
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true 
                    });
                } catch (msgError) {
                    console.error('Erro ao processar mensagem individual:', msgError);
                    await ctx.reply('❌ Erro ao processar uma mensagem. Continuando com as demais...');
                }
            }
        } catch (error) {
            console.error('Erro ao verificar mensagens:', error);
            
            if (error.message === 'Token inválido ou expirado') {
                try {
                    // Tentar renovar o token
                    const tokenResponse = await fetch('https://api.mail.tm/token', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            address: userData.tempMail.email,
                            password: userData.tempMail.password
                        })
                    });

                    if (!tokenResponse.ok) {
                        throw new Error('Não foi possível renovar o token');
                    }

                    const tokenData = await tokenResponse.json();
                    userData.tempMail.token = tokenData.token;
                    saveUserData(userId, userData);

                    // Tentar verificar mensagens novamente
                    const messages = await checkTempMail(tokenData.token);
                    
                    if (!messages || messages.length === 0) {
                        await ctx.telegram.editMessageText(
                            ctx.chat.id,
                            waitMsg.message_id,
                            null,
                            `📭 Sem novas mensagens no email: ${userData.tempMail.email}`
                        );
                        return;
                    }

                    // Mostrar as mensagens
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        waitMsg.message_id,
                        null,
                        `📨 Encontradas ${messages.length} mensagens em ${userData.tempMail.email}`
                    );

                    for (const msg of messages) {
                        try {
                            let messageText = `📨 *Nova mensagem recebida*\n\n`;
                            messageText += `*De:* ${msg.from?.address || 'Desconhecido'}\n`;
                            messageText += `*Para:* ${msg.to?.[0]?.address || userData.tempMail.email}\n`;
                            messageText += `*Assunto:* ${msg.subject || 'Sem assunto'}\n`;
                            messageText += `*Data:* ${new Date(msg.createdAt).toLocaleString()}\n\n`;
                            
                            let content = msg.text || msg.html || 'Sem conteúdo';
                            if (msg.html) {
                                content = content
                                    .replace(/<[^>]*>/g, '')
                                    .replace(/&nbsp;/g, ' ')
                                    .replace(/&amp;/g, '&')
                                    .replace(/&lt;/g, '<')
                                    .replace(/&gt;/g, '>')
                                    .replace(/&quot;/g, '"')
                                    .replace(/&#39;/g, "'");
                            }
                            
                            if (content.length > 1000) {
                                content = content.substring(0, 1000) + '...\n(conteúdo truncado)';
                            }
                            
                            messageText += `*Conteúdo:*\n${content}\n`;
                            
                            await ctx.reply(messageText, { 
                                parse_mode: 'Markdown',
                                disable_web_page_preview: true 
                            });
                        } catch (msgError) {
                            console.error('Erro ao processar mensagem individual:', msgError);
                            await ctx.reply('❌ Erro ao processar uma mensagem. Continuando com as demais...');
                        }
                    }
                } catch (renewError) {
                    console.error('Erro ao renovar token:', renewError);
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        waitMsg.message_id,
                        null,
                        '❌ Sua sessão de email expirou. Por favor, gere um novo email com \`.mail\`'
                    );
                }
            } else {
                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    waitMsg.message_id,
                    null,
                    `❌ Erro ao verificar mensagens: ${error.message}\nPor favor, tente novamente.`
                );
            }
        }
    } catch (error) {
        console.error('Erro geral no comando check:', error);
        await ctx.reply('❌ Erro ao verificar mensagens. Por favor, tente novamente.');
    }
};

// Registrar comandos
registerCommand('mail', handleMailCommand);
registerCommand('check', handleCheckCommand);

// Função para lidar com o comando de verificação de IP
const handleIPCommand = async (ctx) => {
    try {
        const ip = getCommandArgs(ctx);
        if (!ip) {
            await ctx.reply('❌ Uso: /ip ou .ip <endereço IP>\nExemplo: /ip 8.8.8.8');
            return;
        }

        // Validar formato de IP
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
        if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
            await ctx.reply('❌ Formato de IP inválido. Deve ser um endereço IPv4 ou IPv6 válido.');
            return;
        }

        // Enviar mensagem de espera
        const waitMsg = await ctx.reply('⏳ Verificando IP...');

        try {
            const ipInfo = await checkIP(ip);

            // Criar mensagem com a informação
            let message = `🔍 *Informações de IP: ${ip}*\n\n`;
            message += `*Informações Básicas:*\n`;
            message += `• País: ${ipInfo.country}\n`;
            message += `• Cidade: ${ipInfo.city}\n`;
            message += `• ISP: ${ipInfo.isp}\n\n`;
            message += `*Verificação de Segurança:*\n`;
            message += `• Proxy/VPN: ${ipInfo.proxy ? '✅ Sim' : '❌ Não'}\n`;
            message += `• Tor: ${ipInfo.tor ? '✅ Sim' : '❌ Não'}\n`;
            message += `• Hosting: ${ipInfo.hosting ? '✅ Sim' : '❌ Não'}\n`;
            message += `• Nível de Risco: ${ipInfo.riskLevel}\n\n`;
            message += `*Informações Adicionais:*\n`;
            message += `• ASN: ${ipInfo.asn}\n`;
            message += `• Organização: ${ipInfo.organization}\n`;
            message += `• Fuso Horário: ${ipInfo.timezone}`;

            // Salvar no histórico
            const userId = ctx.from.id;
            const userData = loadUserData(userId);
            userData.history.unshift({
                type: 'ip_check',
                ip: ip,
                info: ipInfo,
                timestamp: new Date().toISOString()
            });
            saveUserData(userId, userData);

            // Atualizar mensagem de espera com os resultados
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                message,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error('Erro ao verificar IP:', error);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                waitMsg.message_id,
                null,
                `❌ Erro ao verificar IP: ${error.message}`
            );
        }
    } catch (error) {
        console.error('Erro geral no comando IP:', error);
        await ctx.reply('❌ Erro ao processar o comando. Por favor, tente novamente.');
    }
};

// Registrar comando IP
registerCommand('ip', handleIPCommand);

// Atualizar a mensagem de ajuda
const helpMessage = `🤖 *CardGen Pro Bot*\n\n` +
    `*Comandos disponíveis:*\n` +
    `• \`/start\` ou \`.start\` - Mostrar ajuda e comandos disponíveis\n` +
    `• \`/gen\` ou \`.gen\` - Gerar cartões\n` +
    `• \`/bin\` ou \`.bin\` - Consultar informações de BIN\n` +
    `• \`/cedula\` ou \`.cedula\` - Consultar informações SRI por cédula\n` +
    `• \`/placa\` ou \`.placa\` - Consultar informações Veiculares\n` +
    `• \`/mail\` ou \`.mail\` - Gerar email temporário\n` +
    `• \`/check\` ou \`.check\` - Verificar mensagens do email\n` +
    `• \`/ip\` ou \`.ip\` - Verificar IP e risco de fraude\n` +
    `• \`/favoritos\` ou \`.favoritos\` - Ver BINs favoritos\n` +
    `• \`/agregarbin\` ou \`.agregarbin\` - Salvar BIN nos favoritos\n` +
    `• \`/eliminarbin\` ou \`.eliminarbin\` - Remover BIN dos favoritos\n` +
    `• \`/historial\` ou \`.historial\` - Ver histórico de consultas\n` +
    `• \`/clear\` ou \`.clear\` - Limpar o chat\n` +
    `• \`/limpar\` ou \`.limpar\` - Limpar o chat\n` +
    `• \`/ajuda\` ou \`.ajuda\` - Mostrar ajuda\n\n` +
    `*Exemplos:*\n` +
    `• \`.gen 477349002646|05|2027|123\`\n` +
    `• \`.bin 477349\`\n` +
    `• \`.cedula 17xxxxxxxx\`\n` +
    `• \`.placa PDF9627\`\n` +
    `• \`.mail\`\n` +
    `• \`.check\`\n` +
    `• \`.ip 8.8.8.8\``;

// Iniciar o bot
let isShuttingDown = false;

const startBot = async () => {
    try {
        await bot.launch();
        console.log('Bot iniciado');
        
        // Signal ready to PM2
        if (process.send) {
            process.send('ready');
        }
    } catch (err) {
        console.error('Erro ao iniciar o bot:', err);
        process.exit(1);
    }
};

// Error handling for the bot
bot.catch((err, ctx) => {
    console.error('Erro no manuseio do comando:', err);
    if (ctx && !isShuttingDown) {
        ctx.reply('❌ Ocorreu um erro ao processar o comando. Por favor, tente novamente.');
    }
});

// Graceful shutdown
const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    console.log(`Sinal ${signal} recebido. Iniciando desligamento gracioso...`);
    
    try {
        await bot.stop(signal);
        console.log('Bot parado corretamente');
    } catch (err) {
        console.error('Erro ao parar o bot:', err);
    }
    
    process.exit(0);
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Start the bot
startBot();