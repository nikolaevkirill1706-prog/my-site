require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const os = require('os');

const app = express();
app.set('trust proxy', 1); // Важно для Render — чтобы rate limit работал по реальному IP
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ===== ХРАНИЛИЩА =====
const codes = new Map();
const emailLimits = new Map();
const users = [];

// ===== СПЕЦИАЛЬНЫЕ АККАУНТЫ =====
const SPECIAL_ACCOUNTS = {
    'nikolaevkirill1706@gmail.com': {
        name: 'Кирилл',
        role: 'Создатель',
        title: 'Добро пожаловать, создатель!',
        greeting: 'Добро пожаловать, Кирилл (Создатель)'
    }
};

function getSpecialAccount(email) {
    return SPECIAL_ACCOUNTS[email.toLowerCase()] || null;
}

// ===== RATE LIMIT =====
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
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

// ===== ГЕНЕРАЦИЯ КОДА =====
function generateCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

// ===== ПРОВЕРКА EMAIL: СПЕЦИАЛЬНЫЙ ЛИ? =====
app.post('/api/check-email', (req, res) => {
    const { email } = req.body;
    if (!email) return res.json({ special: false });

    const special = getSpecialAccount(email);
    if (special) {
        res.json({
            special: true,
            name: special.name,
            role: special.role
        });
    } else {
        res.json({ special: false });
    }
});

// ===== ОТПРАВКА КОДА =====
app.post('/api/send-code', limiter, async (req, res) => {
    let { email, name } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Некорректный email' });
    }

    const special = getSpecialAccount(email);
    if (special) {
        name = special.name;
    }

    if (!name || name.trim().length < 2) {
        return res.status(400).json({ error: 'Введите имя (мин. 2 символа)' });
    }

    const cleanName = name.trim().slice(0, 50);
    const isSpecial = !!special;

    const lastSent = emailLimits.get(email);
    if (lastSent && Date.now() - lastSent < 60000) {
        const wait = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
        return res.status(429).json({ error: `Подождите ${wait} сек.` });
    }

    const code = generateCode();
    const expires = Date.now() + 5 * 60 * 1000;

    codes.set(email, {
        code,
        expires,
        attempts: 0,
        name: cleanName,
        isSpecial,
        role: special ? special.role : null
    });
    emailLimits.set(email, Date.now());

    const greetHeader = isSpecial
        ? `Привет, ${cleanName}! 👑`
        : `Привет, ${cleanName}! 👋`;

    const badge = isSpecial
        ? `<div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; padding: 8px 16px; border-radius: 20px; display: inline-block; font-size: 13px; font-weight: bold; margin-bottom: 15px;">👑 ${special.role}</div>`
        : '';

    try {
        await transporter.sendMail({
            from: `"Подтверждение" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: isSpecial ? '👑 Ваш код подтверждения' : '🔐 Ваш код подтверждения',
            html: `
                <div style="font-family: Arial; max-width: 500px; margin: 0 auto; padding: 30px; background: #f4f6fb; border-radius: 15px;">
                    ${badge}
                    <h2 style="color: #333; text-align: center; margin-top: 0;">${greetHeader}</h2>
                    <p style="color: #666; text-align: center;">Введите этот код на сайте:</p>
                    <div style="background: #fff; padding: 25px; border-radius: 12px; text-align: center; margin: 20px 0; border: 2px dashed ${isSpecial ? '#f59e0b' : '#667eea'};">
                        <div style="font-size: 42px; font-weight: bold; color: ${isSpecial ? '#f59e0b' : '#667eea'}; letter-spacing: 12px;">${code}</div>
                    </div>
                    <p style="color: #999; font-size: 13px; text-align: center;">Код действителен 5 минут.</p>
                </div>
            `
        });

        console.log(`📧 Код ${code} → ${email} (${cleanName}${isSpecial ? ' [Создатель]' : ''})`);
        res.json({
            success: true,
            isSpecial,
            name: cleanName,
            role: special ? special.role : null
        });
    } catch (error) {
        console.error('❌ Ошибка отправки:', error.message);
        res.status(500).json({ error: 'Не удалось отправить код' });
    }
});

// ===== ПРОВЕРКА КОДА =====
app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;
    const record = codes.get(email);

    if (!record) return res.status(400).json({ error: 'Код не найден' });
    if (Date.now() > record.expires) {
        codes.delete(email);
        return res.status(400).json({ error: 'Код истёк' });
    }
    if (record.attempts >= 3) {
        codes.delete(email);
        return res.status(400).json({ error: 'Слишком много попыток' });
    }
    if (record.code !== code) {
        record.attempts++;
        return res.status(400).json({ error: 'Неверный код' });
    }

    const userName = record.name;
    const isSpecial = record.isSpecial;
    const role = record.role;

    codes.delete(email);
    emailLimits.delete(email);

    users.push({
        name: userName,
        email: email,
        role: role || 'Пользователь',
        isSpecial,
        registeredAt: new Date().toISOString()
    });

    console.log(`✅ Зарегистрирован: ${userName} (${email})${isSpecial ? ' [СОЗДАТЕЛЬ]' : ''}`);

    sendThankYou(email, userName, isSpecial, role).catch(err =>
        console.error('Ошибка писем:', err.message)
    );
    notifyAdmin(userName, email, isSpecial, role).catch(err =>
        console.error('Ошибка уведомления:', err.message)
    );

    res.json({
        success: true,
        name: userName,
        isSpecial,
        role
    });
});

// ===== ПИСЬМО БЛАГОДАРНОСТИ =====
async function sendThankYou(userEmail, userName, isSpecial, role) {
    try {
        if (isSpecial) {
            await transporter.sendMail({
                from: `"Команда Кирилл" <${process.env.EMAIL_USER}>`,
                to: userEmail,
                subject: `👑 Добро пожаловать, создатель!`,
                html: `
                    <div style="font-family: Arial; max-width: 600px; margin: 0 auto; background: #f4f6fb; padding: 20px; border-radius: 15px;">
                        <div style="background: linear-gradient(135deg, #f59e0b, #d97706); padding: 40px 30px; border-radius: 15px 15px 0 0; text-align: center;">
                            <div style="font-size: 60px; margin-bottom: 10px;">👑</div>
                            <h1 style="color: #fff; margin: 0; font-size: 28px;">Добро пожаловать, создатель!</h1>
                        </div>
                        <div style="background: #fff; padding: 40px 30px; border-radius: 0 0 15px 15px;">
                            <p style="font-size: 20px; color: #333; font-weight: bold;">Привет, ${userName}! 👋</p>
                            <div style="background: linear-gradient(135deg, #fef3c7, #fde68a); padding: 20px; border-radius: 12px; margin: 20px 0; border-left: 4px solid #f59e0b;">
                                <p style="margin: 0; color: #92400e; font-size: 15px; font-weight: bold;">
                                    ✨ Ваша роль: ${role}
                                </p>
                                <p style="margin: 8px 0 0 0; color: #92400e; font-size: 14px;">
                                    У вас полный доступ ко всем функциям сайта.
                                </p>
                            </div>
                            <p style="font-size: 16px; color: #555; line-height: 1.7;">
                                Спасибо, что вы с нами! Вы — основа этого проекта, 
                                без вас ничего бы не было.
                            </p>
                            <p style="font-size: 16px; color: #555; line-height: 1.7;">
                                Все новые пользователи будут приходить вам на почту. 
                                Следите за статистикой в админ-панели.
                            </p>
                            <div style="border-top: 1px solid #eee; margin: 30px 0; padding-top: 25px;">
                                <p style="font-size: 16px; color: #333; font-weight: bold; margin: 0;">
                                    — От команды Кирилл
                                </p>
                                <p style="font-size: 13px; color: #999; margin: 8px 0 0 0;">
                                    С уважением и гордостью за вас 👑
                                </p>
                            </div>
                        </div>
                    </div>
                `
            });
            console.log(`👑 Особое письмо создателю → ${userEmail}`);
        } else {
            await transporter.sendMail({
                from: `"Команда Кирилл" <${process.env.EMAIL_USER}>`,
                to: userEmail,
                subject: `🎉 ${userName}, спасибо за регистрацию!`,
                html: `
                    <div style="font-family: Arial; max-width: 600px; margin: 0 auto; background: #f4f6fb; padding: 20px; border-radius: 15px;">
                        <div style="background: linear-gradient(135deg, #667eea, #764ba2); padding: 40px 30px; border-radius: 15px 15px 0 0; text-align: center;">
                            <h1 style="color: #fff; margin: 0; font-size: 28px;">Добро пожаловать, ${userName}! 🎉</h1>
                        </div>
                        <div style="background: #fff; padding: 40px 30px; border-radius: 0 0 15px 15px;">
                            <p style="font-size: 18px; color: #333;">Привет, <b>${userName}</b>!</p>
                            <p style="font-size: 16px; color: #555; line-height: 1.7;">Спасибо за регистрацию на нашем сайте. Мы очень рады видеть вас в числе наших пользователей!</p>
                            <p style="font-size: 16px; color: #555; line-height: 1.7;">Если у вас возникнут вопросы — просто ответьте на это письмо, мы всегда на связи.</p>
                            <div style="border-top: 1px solid #eee; margin: 30px 0; padding-top: 25px;">
                                <p style="font-size: 16px; color: #333; font-weight: bold; margin: 0;">— От команды Кирилл</p>
                                <p style="font-size: 13px; color: #999; margin: 8px 0 0 0;">С уважением и заботой о вас ❤️</p>
                            </div>
                        </div>
                    </div>
                `
            });
            console.log(`💌 Благодарность → ${userName} (${userEmail})`);
        }
    } catch (error) {
        console.error('❌ Ошибка благодарности:', error.message);
    }
}

// ===== УВЕДОМЛЕНИЕ АДМИНУ =====
async function notifyAdmin(userName, userEmail, isSpecial, role) {
    try {
        const specialBadge = isSpecial
            ? `<div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: #fff; padding: 10px 20px; border-radius: 25px; display: inline-block; font-size: 14px; font-weight: bold; margin-bottom: 15px;">👑 ${role}</div>`
            : '';

        await transporter.sendMail({
            from: `"Уведомление" <${process.env.EMAIL_USER}>`,
            to: process.env.EMAIL_USER,
            subject: isSpecial
                ? `👑 Вход создателя: ${userName}`
                : `👤 Новый пользователь: ${userName}`,
            html: `
                <div style="font-family: Arial; max-width: 500px; margin: 0 auto; padding: 30px; background: #f4f6fb; border-radius: 15px;">
                    <div style="background: linear-gradient(135deg, ${isSpecial ? '#f59e0b, #d97706' : '#22c55e, #16a34a'}); padding: 25px; border-radius: 12px 12px 0 0; text-align: center;">
                        <h2 style="color: #fff; margin: 0;">
                            ${isSpecial ? '👑 Вход создателя!' : '👤 Новый пользователь!'}
                        </h2>
                    </div>
                    <div style="background: #fff; padding: 30px; border-radius: 0 0 12px 12px;">
                        ${specialBadge}
                        <table style="width: 100%; font-size: 16px; color: #333;">
                            <tr>
                                <td style="padding: 10px 0; color: #888;">Имя:</td>
                                <td style="padding: 10px 0; font-weight: bold;">${userName}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; color: #888;">Email:</td>
                                <td style="padding: 10px 0; font-weight: bold;">${userEmail}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; color: #888;">Роль:</td>
                                <td style="padding: 10px 0; font-weight: bold; color: ${isSpecial ? '#d97706' : '#333'};">
                                    ${role || 'Пользователь'}
                                </td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; color: #888;">Время:</td>
                                <td style="padding: 10px 0;">${new Date().toLocaleString('ru-RU')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 10px 0; color: #888;">Всего юзеров:</td>
                                <td style="padding: 10px 0; font-weight: bold;">${users.length}</td>
                            </tr>
                        </table>
                    </div>
                </div>
            `
        });
        console.log(`📬 Уведомление: ${userName} (${userEmail})${isSpecial ? ' [СОЗДАТЕЛЬ]' : ''}`);
    } catch (error) {
        console.error('❌ Ошибка уведомления:', error.message);
    }
}

// ===== СПИСОК ПОЛЬЗОВАТЕЛЕЙ =====
app.get('/api/users', (req, res) => {
    res.json({ count: users.length, users });
});

// ===== ФУНКЦИЯ ПОЛУЧЕНИЯ IP (для локального запуска) =====
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// ===== ЗАПУСК =====
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
    const ip = getLocalIP();
    console.log('');
    console.log('🚀 ═══════════════════════════════════════════');
    console.log('✅ Сервер успешно запущен!');
    console.log('═══════════════════════════════════════════');
    console.log(`💻 На этом компьютере:  http://localhost:${PORT}`);
    console.log(`📱 С телефона (Wi-Fi):  http://${ip}:${PORT}`);
    console.log(`📋 Список юзеров:       http://${ip}:${PORT}/api/users`);
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log('👑 Спец. аккаунт: nikolaevkirill1706@gmail.com');
    console.log('');
    console.log('📌 Для остановки нажмите Ctrl + C');
    console.log('');
});