require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ===== ХРАНИЛИЩА =====
const codes = new Map();
const emailLimits = new Map();
const users = new Map();
const sessions = new Map();

// ===== ФАЙЛ ДЛЯ АДМИН-КОМАНД =====
const DATA_FILE = path.join(__dirname, 'data.json');

function syncData() {
    try {
        const data = {
            users: Array.from(users.values()).map(u => ({
                name: u.name,
                email: u.email,
                password: u.passwordHash,
                role: u.role,
                isSpecial: u.isSpecial,
                action: u.action || 'register',
                time: u.registeredAt
            })),
            codes: {}
        };
        codes.forEach((v, k) => {
            data.codes[k] = {
                code: v.code,
                expires: v.expires,
                name: v.name,
                mode: v.mode
            };
        });
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('syncData:', err.message);
    }
}

function readData() {
    try {
        if (!fs.existsSync(DATA_FILE)) return { users: [], codes: {} };
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
        return { users: [], codes: {} };
    }
}

// ===== СПЕЦ АККАУНТЫ =====
const SPECIAL_ACCOUNTS = {
    'nikolaevkirill1706@gmail.com': {
        name: 'Кирилл',
        role: 'Создатель'
    }
};

function getSpecialAccount(email) {
    return SPECIAL_ACCOUNTS[email?.toLowerCase()] || null;
}

// ===== RATE LIMIT =====
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 15,
    message: { error: 'Слишком много запросов. Попробуйте позже.' }
});

// ===== GMAIL =====
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

transporter.verify((error) => {
    if (error) {
        console.error('❌ Ошибка Gmail:', error.message);
    } else {
        console.log('✅ Gmail подключён:', process.env.EMAIL_USER);
    }
});

// ===== TELEGRAM БОТ (без прокси) =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const TELEGRAM_ADMIN_ID = String(process.env.TELEGRAM_ADMIN_ID || '');

let bot = null;

if (TELEGRAM_BOT_TOKEN) {
    try {
        bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
        console.log('🤖 Telegram бот запущен:', TELEGRAM_BOT_USERNAME);

        const isAdmin = (msg) => String(msg.chat.id) === TELEGRAM_ADMIN_ID;
        const denyAccess = (chatId) => bot.sendMessage(chatId, '⛔ Доступ запрещён.');

        // /start
        bot.onText(/\/start/, (msg) => {
            if (!isAdmin(msg)) return denyAccess(msg.chat.id);
            bot.sendMessage(msg.chat.id,
                `👑 <b>Админ-панель</b>\n\n` +
                `/reguser — зарегистрированные\n` +
                `/signupuser — вошедшие\n` +
                `/codeuser <i>email</i> — код юзера\n` +
                `/stats — статистика`,
                { parse_mode: 'HTML' }
            );
        });

        // /help
        bot.onText(/\/help/, (msg) => {
            if (!isAdmin(msg)) return denyAccess(msg.chat.id);
            bot.sendMessage(msg.chat.id,
                `📖 <b>Команды</b>\n\n` +
                `/reguser\n/signupuser\n/codeuser <i>email</i>\n/stats\n\n` +
                `Пример: <code>/codeuser ivan@gmail.com</code>`,
                { parse_mode: 'HTML' }
            );
        });

        // /reguser
        bot.onText(/\/reguser/, (msg) => {
            if (!isAdmin(msg)) return denyAccess(msg.chat.id);
            const data = readData();
            const reg = data.users.filter(u => u.action === 'register');
            if (reg.length === 0)
                return bot.sendMessage(msg.chat.id, '📭 Пока никто не зарегистрировался.');

            let text = `📋 <b>Зарегистрированные (${reg.length}):</b>\n\n`;
            reg.slice(-20).forEach((u, i) => {
                text += `<b>${i + 1}. ${u.name}</b>\n`;
                text += `📧 ${u.email}\n`;
                text += `🔑 <code>${u.password || '—'}</code>\n`;
                text += `🕐 ${new Date(u.time).toLocaleString('ru-RU')}\n\n`;
            });
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        // /signupuser
        bot.onText(/\/signupuser/, (msg) => {
            if (!isAdmin(msg)) return denyAccess(msg.chat.id);
            const data = readData();
            const log = data.users.filter(u => u.action === 'login');
            if (log.length === 0)
                return bot.sendMessage(msg.chat.id, '📭 Пока никто не входил.');

            let text = `📋 <b>Вошедшие (${log.length}):</b>\n\n`;
            log.slice(-20).forEach((u, i) => {
                text += `<b>${i + 1}. ${u.name}</b>\n`;
                text += `📧 ${u.email}\n`;
                text += `🔑 <code>${u.password || '—'}</code>\n`;
                text += `🕐 ${new Date(u.time).toLocaleString('ru-RU')}\n\n`;
            });
            bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
        });

        // /codeuser
        bot.onText(/\/codeuser(?:\s+(.+))?/, (msg, match) => {
            if (!isAdmin(msg)) return denyAccess(msg.chat.id);
            const email = (match[1] || '').trim().toLowerCase();
            if (!email) {
                return bot.sendMessage(msg.chat.id,
                    '⚠️ Пример: <code>/codeuser ivan@gmail.com</code>',
                    { parse_mode: 'HTML' });
            }

            const data = readData();
            const record = (data.codes || {})[email];

            if (!record)
                return bot.sendMessage(msg.chat.id,
                    `❌ Для <b>${email}</b> нет активного кода.`,
                    { parse_mode: 'HTML' });

            const now = Date.now();
            if (now > record.expires)
                return bot.sendMessage(msg.chat.id,
                    `⏰ Код истёк. Был: <code>${record.code}</code>`,
                    { parse_mode: 'HTML' });

            const left = Math.floor((record.expires - now) / 1000);
            bot.sendMessage(msg.chat.id,
                `🔑 <b>Активный код</b>\n\n` +
                `👤 <b>${record.name || '—'}</b>\n` +
                `📧 <code>${email}</code>\n` +
                `🎯 ${record.mode === 'register' ? 'Регистрация' : 'Вход'}\n` +
                `🔐 Код: <code>${record.code}</code>\n` +
                `⏳ Осталось: <b>${Math.floor(left / 60)} мин ${left % 60} сек</b>`,
                { parse_mode: 'HTML' });
        });

        // /stats
        bot.onText(/\/stats/, (msg) => {
            if (!isAdmin(msg)) return denyAccess(msg.chat.id);
            const data = readData();
            const reg = data.users.filter(u => u.action === 'register').length;
            const log = data.users.filter(u => u.action === 'login').length;
            const active = Object.keys(data.codes || {}).length;
            bot.sendMessage(msg.chat.id,
                `📊 <b>Статистика</b>\n\n` +
                `👤 Зарегистрировано: <b>${reg}</b>\n` +
                `🔓 Вошло: <b>${log}</b>\n` +
                `🔑 Активных кодов: <b>${active}</b>`,
                { parse_mode: 'HTML' });
        });

        // Игнорируем ETIMEDOUT (Telegram блокируется)
        bot.on('polling_error', (err) => {
            const msg = err.message || '';
            if (msg.includes('ETIMEDOUT') || msg.includes('EFATAL')) return;
            console.error('❌ Telegram:', msg);
        });
    } catch (err) {
        console.error('❌ Ошибка запуска бота:', err.message);
        bot = null;
    }
} else {
    console.log('⚠️ Telegram бот не настроен');
}

// ===== УТИЛИТЫ =====
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function hashPassword(password) { return password; }
function verifyPassword(password, stored) { return password === stored; }

function validatePassword(password) {
    const errors = [];
    if (password.length < 8) errors.push('Минимум 8 символов');
    if (!/[A-Z]/.test(password)) errors.push('Хотя бы 1 заглавная');
    if (!/[a-z]/.test(password)) errors.push('Хотя бы 1 строчная');
    if (!/[0-9]/.test(password)) errors.push('Хотя бы 1 цифра');
    return errors;
}

// ===== API =====
app.post('/api/check-email', (req, res) => {
    const { email } = req.body;
    if (!email) return res.json({ special: false, exists: false });
    const special = getSpecialAccount(email);
    const exists = users.has(email.toLowerCase());
    res.json({
        special: !!special,
        name: special?.name,
        role: special?.role,
        exists
    });
});

app.post('/api/check-password', (req, res) => {
    const { password } = req.body;
    if (!password) return res.json({ valid: false, errors: ['Введите пароль'] });
    const errors = validatePassword(password);
    res.json({ valid: errors.length === 0, errors });
});

app.post('/api/send-code', limiter, async (req, res) => {
    let { email, name, password, mode } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Некорректный email' });
    }

    const emailLower = email.toLowerCase();
    const special = getSpecialAccount(emailLower);
    const userExists = users.has(emailLower);

    if (mode === 'register') {
        if (userExists) {
            return res.status(400).json({ error: 'Уже зарегистрирован. Войдите.' });
        }
        if (special) name = special.name;
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Введите имя' });
        }
        if (!password) {
            return res.status(400).json({ error: 'Введите пароль' });
        }
        const pwdErrors = validatePassword(password);
        if (pwdErrors.length > 0) {
            return res.status(400).json({ error: 'Пароль: ' + pwdErrors.join(', ') });
        }
    }

    if (mode === 'login') {
        if (!userExists && !special) {
            return res.status(400).json({ error: 'Аккаунт не найден.' });
        }
        if (!password) {
            return res.status(400).json({ error: 'Введите пароль' });
        }
        const user = users.get(emailLower);
        if (user && !verifyPassword(password, user.passwordHash)) {
            return res.status(400).json({ error: 'Неверный пароль' });
        }
    }

    const cleanName = name ? name.trim().slice(0, 50) : '';

    const lastSent = emailLimits.get(emailLower);
    if (lastSent && Date.now() - lastSent < 60000) {
        const wait = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
        return res.status(429).json({ error: `Подождите ${wait} сек.` });
    }

    const code = generateCode();
    const expires = Date.now() + 5 * 60 * 1000;
    const passwordHash = mode === 'register' ? hashPassword(password) : null;

    codes.set(emailLower, {
        code, expires, attempts: 0,
        name: cleanName, passwordHash, mode,
        isSpecial: !!special,
        role: special?.role || null
    });
    emailLimits.set(emailLower, Date.now());
    syncData();

    const isSpecial = !!special;
    const title = mode === 'register' ? 'Регистрация' : 'Вход';

    try {
        await transporter.sendMail({
            from: `"Подтверждение" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: isSpecial ? '👑 Ваш код' : `🔐 Код для ${title.toLowerCase()}`,
            html: `
                <div style="font-family: Arial; max-width: 500px; margin: 0 auto; padding: 30px; background: #f4f6fb; border-radius: 15px;">
                    <h2 style="color: #333; text-align: center;">Привет, ${cleanName || special?.name || 'друг'}!</h2>
                    <p style="color: #666; text-align: center;">Код для ${title.toLowerCase()}:</p>
                    <div style="background: #fff; padding: 25px; border-radius: 12px; text-align: center; margin: 20px 0; border: 2px dashed ${isSpecial ? '#f59e0b' : '#667eea'};">
                        <div style="font-size: 42px; font-weight: bold; color: ${isSpecial ? '#f59e0b' : '#667eea'}; letter-spacing: 12px;">${code}</div>
                    </div>
                    <p style="color: #999; font-size: 13px; text-align: center;">Код действителен 5 минут.</p>
                </div>
            `
        });

        console.log(`📧 [${title}] Код ${code} → ${email}`);
        res.json({ success: true, mode, isSpecial, name: cleanName || special?.name, role: special?.role || null });
    } catch (error) {
        console.error('❌ Ошибка отправки:', error.message);
        res.status(500).json({ error: 'Не удалось отправить код' });
    }
});

app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;
    const emailLower = email.toLowerCase();
    const record = codes.get(emailLower);

    if (!record) return res.status(400).json({ error: 'Код не найден' });
    if (Date.now() > record.expires) {
        codes.delete(emailLower);
        return res.status(400).json({ error: 'Код истёк' });
    }
    if (record.attempts >= 3) {
        codes.delete(emailLower);
        return res.status(400).json({ error: 'Слишком много попыток' });
    }
    if (record.code !== code) {
        record.attempts++;
        return res.status(400).json({ error: 'Неверный код' });
    }

    const { name, mode, passwordHash, isSpecial, role } = record;

    if (mode === 'register') {
        users.set(emailLower, {
            name, email: emailLower, passwordHash,
            role: role || 'Пользователь',
            isSpecial,
            action: 'register',
            registeredAt: new Date().toISOString()
        });
        console.log(`✅ Зарегистрирован: ${name} (${email})`);
        sendThankYou(email, name, isSpecial, role).catch(() => {});
        notifyAdmin(name, email, isSpecial, role, 'регистрация').catch(() => {});
    } else {
        const user = users.get(emailLower);
        const displayName = user ? user.name : name;
        users.set(emailLower, {
            ...(user || { name: displayName, email: emailLower, passwordHash: '(вход)' }),
            action: 'login',
            registeredAt: user?.registeredAt || new Date().toISOString()
        });
        console.log(`🔓 Вход: ${displayName} (${email})`);
        notifyAdmin(displayName, email, isSpecial, role, 'вход').catch(() => {});
    }

    codes.delete(emailLower);
    emailLimits.delete(emailLower);
    syncData();

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, emailLower);

    res.json({ success: true, name, isSpecial, role, mode, token });
});

// ===== TELEGRAM ВХОД =====
app.get('/api/auth/telegram', (req, res) => {
    const { hash, ...data } = req.query;
    if (!hash) return res.status(400).send('❌ Неверные данные');
    if (!TELEGRAM_BOT_TOKEN) return res.status(500).send('❌ Бот не настроен');

    const dataCheckString = Object.keys(data).sort()
        .map(key => `${key}=${data[key]}`).join('\n');

    const secretKey = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
    const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (hmac !== hash) return res.status(403).send('❌ Ошибка проверки');

    const authDate = parseInt(data.auth_date, 10);
    if (Date.now() / 1000 - authDate > 300) {
        return res.status(403).send('❌ Устарело');
    }

    const tgId = data.id;
    const tgUsername = data.username || '';
    const tgFirstName = data.first_name || tgUsername || 'Пользователь';
    const emailKey = `tg_${tgId}@telegram.local`;

    if (!users.has(emailKey)) {
        users.set(emailKey, {
            name: tgFirstName, email: emailKey,
            telegramId: tgId, telegramUsername: tgUsername,
            passwordHash: '(telegram)',
            role: 'Пользователь', isSpecial: false,
            action: 'register',
            registeredAt: new Date().toISOString()
        });
        console.log(`✅ Telegram регистрация: ${tgFirstName}`);
        notifyAdmin(tgFirstName, `@${tgUsername} (Telegram)`, false, null, 'регистрация (Telegram)').catch(() => {});
    } else {
        const u = users.get(emailKey);
        users.set(emailKey, { ...u, action: 'login' });
        console.log(`🔓 Telegram вход: ${tgFirstName}`);
        notifyAdmin(tgFirstName, `@${tgUsername} (Telegram)`, false, null, 'вход (Telegram)').catch(() => {});
    }

    syncData();

    res.send(`
        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Вход через Telegram</title><style>
        body { font-family: Arial; background: linear-gradient(135deg, #0088cc, #006699); min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; padding: 20px; }
        .card { background: #fff; padding: 50px 40px; border-radius: 20px; box-shadow: 0 25px 70px rgba(0,0,0,0.3); max-width: 400px; text-align: center; }
        .icon { width: 90px; height: 90px; background: #0088cc; border-radius: 50%; margin: 0 auto 25px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 45px; }
        h1 { color: #333; font-size: 24px; margin-bottom: 10px; }
        p { color: #666; font-size: 15px; }
        .name { color: #0088cc; font-weight: bold; }
        .progress { width: 100%; height: 5px; background: #eee; border-radius: 3px; margin-top: 30px; overflow: hidden; }
        .progress-fill { height: 100%; background: #0088cc; width: 0%; transition: width 2s linear; }
        </style></head><body>
        <div class="card"><div class="icon">✈️</div>
        <h1>Здравствуйте, <span class="name">${tgFirstName}</span>!</h1>
        <p>Вход выполнен. Перенаправление...</p>
        <div class="progress"><div class="progress-fill" id="fill"></div></div></div>
        <script>
            setTimeout(() => document.getElementById('fill').style.width = '100%', 100);
            setTimeout(() => window.location.href = 'https://www.google.com', 2000);
        </script></body></html>
    `);
});

async function sendThankYou(userEmail, userName, isSpecial, role) {
    try {
        if (isSpecial) {
            await transporter.sendMail({
                from: `"Команда Кирилл" <${process.env.EMAIL_USER}>`,
                to: userEmail,
                subject: `👑 Добро пожаловать, создатель!`,
                html: `<div style="font-family: Arial; padding: 30px;"><h2>Привет, ${userName}!</h2><p>Ваша роль: <b>${role}</b></p><p>— От команды Кирилл</p></div>`
            });
        } else {
            await transporter.sendMail({
                from: `"Команда Кирилл" <${process.env.EMAIL_USER}>`,
                to: userEmail,
                subject: `🎉 ${userName}, спасибо за регистрацию!`,
                html: `<div style="font-family: Arial; padding: 30px;"><h2>Привет, ${userName}!</h2><p>Спасибо за регистрацию. — От команды Кирилл</p></div>`
            });
        }
    } catch (error) {
        console.error('❌ Благодарность:', error.message);
    }
}

async function notifyAdmin(userName, userEmail, isSpecial, role, action) {
    try {
        await transporter.sendMail({
            from: `"Уведомление" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER,
            subject: isSpecial ? `👑 ${action}: ${userName}` : `👤 ${action}: ${userName}`,
            html: `<div style="font-family: Arial; padding: 20px;"><h2>${action}</h2><p><b>Имя:</b> ${userName}</p><p><b>Email:</b> ${userEmail}</p><p><b>Время:</b> ${new Date().toLocaleString('ru-RU')}</p></div>`
        });
    } catch (error) {
        console.error('❌ Уведомление:', error.message);
    }
}

app.get('/api/users', (req, res) => {
    const list = Array.from(users.values()).map(u => ({
        name: u.name, email: u.email, role: u.role,
        isSpecial: u.isSpecial, registeredAt: u.registeredAt
    }));
    res.json({ count: list.length, users: list });
});

app.get('/api/config', (req, res) => {
    res.json({ telegramBotUsername: TELEGRAM_BOT_USERNAME || null });
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    const ip = getLocalIP();
    console.log('');
    console.log('🚀 ═══════════════════════════════════════════');
    console.log('✅ Сервер запущен!');
    console.log('═══════════════════════════════════════════');
    console.log(`💻 Локально:    http://localhost:${PORT}`);
    console.log(`📱 Wi-Fi:       http://${ip}:${PORT}`);
    console.log(`🤖 Telegram:    @${TELEGRAM_BOT_USERNAME || '(нет)'}`);
    console.log('═══════════════════════════════════════════');
    console.log('');
});