require('dotenv').config()
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const schedule = require('node-schedule');
const { Calendar } = require('calendar');
const path = require('path');


console.log('DB_USER:', process.env.DB_USER);
console.log('API_TOKEN:', process.env.API_TOKEN);

// Настройка логирования
const logger = {
  info: (msg) => console.log(`${new Date().toISOString()} - INFO - ${msg}`),
  error: (msg) => console.error(`${new Date().toISOString()} - ERROR - ${msg}`),
};

// Настройка базы данных
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: 'localhost',
  database: 'menstrual_cycle',
  password: process.env.DB_PASSWORD || '1234',
  port: 5432,
});

// Настройка Telegram бота
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  logger.error('API_TOKEN не найден в переменных окружения');
  process.exit(1);
}
const bot = new Telegraf(API_TOKEN);

// Глобальный планировщик
let scheduler = null;

// Админский chat_id для уведомлений
const ADMIN_CHAT_ID = '5915898367';

// Хранение message_id для каждого chat_id
const messageIds = new Map();

// Кнопки меню
const startMenu = () => {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Начать', 'begin')],
  ]);
  logger.info('Формирование startMenu: ' + JSON.stringify(keyboard.reply_markup));
  return keyboard.reply_markup;
};

const mainMenu = async (ctx, user) => {
  const client = await pool.connect();
  try {
    const cycleResult = await client.query(
      'SELECT date FROM cycles WHERE user_id = $1 AND is_menstruation = true ORDER BY date DESC LIMIT 1',
      [user.id]
    );
    const hasPreviousCycle = cycleResult.rows.length > 0;
    const buttons = [
      [Markup.button.callback('📍 Начало месячных', 'start_period')],
      [Markup.button.callback('❤️ Отметить половой акт', 'sex')],
    ];
    if (hasPreviousCycle && !user.menstruation_active) {
      buttons.push([Markup.button.callback('🔄 Снять отмену месячных', 'restore_period')]);
    }
    buttons.push([Markup.button.callback('📅 Календарь', 'calendar')]);
    return Markup.inlineKeyboard(buttons).reply_markup;
  } finally {
    client.release();
  }
};

const periodMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🗑 Убрать отметку месячных за сегодня', 'remove_today_period')],
    [Markup.button.callback('❤️ Отметить половой акт', 'sex')],
    [Markup.button.callback('📅 Календарь', 'calendar')],
    [Markup.button.callback('🏁 Конец месячных', 'end_period')],
  ]).reply_markup;

// Динамическое меню для уведомлений
const markDayMenu = (hasPeriodToday) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(hasPeriodToday ? '🗑 Убрать отметку месячных за сегодня' : '📌 Отметить месячные', hasPeriodToday ? 'remove_today_period' : 'mark_day')],
    [Markup.button.callback('❤️ Отметить половой акт', 'sex')],
    [Markup.button.callback('📅 Календарь', 'calendar')],
    [Markup.button.callback('🏁 Конец месячных', 'end_period')],
  ]).reply_markup;

// Форматирование даты в ДД.ММ.ГГГГ
const formatDate = (date) => {
  const d = new Date(date);
  return `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()}`;
};

// Обработчики
bot.command('start', async (ctx) => {
  logger.info(`Обработка /start для chat_id: ${ctx.chat.id}`);
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM users WHERE chat_id = $1',
      [ctx.chat.id]
    );
    let user = result.rows[0];
    if (!user) {
      logger.info(`Создание нового пользователя: ${ctx.chat.id}`);
      await client.query(
        'INSERT INTO users (chat_id, username, registration_date) VALUES ($1, $2, NOW())',
        [ctx.chat.id, ctx.from.username || '']
      );
      user = { chat_id: ctx.chat.id, username: ctx.from.username || '', menstruation_active: false };
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `Новый пользователь зарегистрирован! Chat ID: ${ctx.chat.id}`);
    }
    const reply = await ctx.reply('Добро пожаловать в бот для отслеживания менструального цикла!', {
      reply_markup: startMenu(),
    });
    messageIds.set(ctx.chat.id, reply.message_id);
    logger.info(`Ответ на /start отправлен для chat_id: ${ctx.chat.id}, message_id: ${reply.message_id}`);
  } catch (err) {
    logger.error(`Ошибка в обработчике /start: ${err}`);
    await ctx.reply('Произошла ошибка. Попробуйте снова.');
  } finally {
    client.release();
  }
});

bot.on('callback_query', async (ctx) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM users WHERE chat_id = $1',
      [ctx.chat.id]
    );
    const user = result.rows[0];
    if (!user) {
      await ctx.reply('Пользователь не найден. Пожалуйста, начните с /start.');
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const callbackData = ctx.update.callback_query.data;
    const currentMessageId = ctx.update.callback_query.message.message_id;

    const prevMessageId = messageIds.get(ctx.chat.id);
    if (prevMessageId && callbackData !== 'sex' && callbackData !== 'calendar') {
      try {
        await bot.telegram.deleteMessage(ctx.chat.id, prevMessageId);
      } catch (err) {
        logger.error(`Ошибка удаления сообщения ${prevMessageId}: ${err}`);
      }
    }

    if (callbackData === 'begin') {
      const reply = await ctx.reply('Выберите действие:', {
        reply_markup: await mainMenu(ctx, user),
      });
      messageIds.set(ctx.chat.id, reply.message_id);
    } else if (callbackData === 'start_period') {
      await client.query(
        'UPDATE users SET menstruation_active = true WHERE chat_id = $1',
        [ctx.chat.id]
      );
      await client.query(
        'INSERT INTO cycles (user_id, date, is_menstruation) VALUES ($1, $2, $3)',
        [user.id, today, true]
      );
      schedule.scheduleJob(
        `notification_${ctx.chat.id}`,
        { hour: 9, minute: 0 },
        () => sendNotification(bot, ctx.chat.id)
      );
      const reply = await ctx.reply('Месячные начались. Ежедневные уведомления активированы.', {
        reply_markup: periodMenu(),
      });
      messageIds.set(ctx.chat.id, reply.message_id);
    } else if (callbackData === 'mark_day') {
      if (user.menstruation_active) {
        await client.query(
          'INSERT INTO cycles (user_id, date, is_menstruation) VALUES ($1, $2, $3)',
          [user.id, today, true]
        );
        const reply = await ctx.reply('День месячных зафиксирован.', { reply_markup: markDayMenu(true) });
        messageIds.set(ctx.chat.id, reply.message_id);
      }
    } else if (callbackData === 'remove_today_period') {
      const cycleResult = await client.query(
        'SELECT * FROM cycles WHERE user_id = $1 AND date = $2 AND is_menstruation = true',
        [user.id, today]
      );
      const cycle = cycleResult.rows[0];
      if (cycle) {
        await client.query(
          'DELETE FROM cycles WHERE id = $1',
          [cycle.id]
        );
        await client.query(
          'UPDATE users SET menstruation_active = false WHERE chat_id = $1',
          [ctx.chat.id]
        );
        schedule.cancelJob(`notification_${ctx.chat.id}`);
        const reply = await ctx.reply('Отметка месячных за сегодня удалена.', {
          reply_markup: await mainMenu(ctx, user),
        });
        messageIds.set(ctx.chat.id, reply.message_id);
      } else {
        const reply = await ctx.reply('Нет отметки месячных за сегодня.', { reply_markup: periodMenu() });
        messageIds.set(ctx.chat.id, reply.message_id);
      }
    } else if (callbackData === 'restore_period') {
      const cycleResult = await client.query(
        'SELECT * FROM cycles WHERE user_id = $1 AND date = $2 AND is_menstruation = true',
        [user.id, today]
      );
      if (cycleResult.rows.length === 0) {
        await client.query(
          'INSERT INTO cycles (user_id, date, is_menstruation) VALUES ($1, $2, $3)',
          [user.id, today, true]
        );
        await client.query(
          'UPDATE users SET menstruation_active = true WHERE chat_id = $1',
          [ctx.chat.id]
        );
        schedule.scheduleJob(
          `notification_${ctx.chat.id}`,
          { hour: 9, minute: 0 },
          () => sendNotification(bot, ctx.chat.id)
        );
        const reply = await ctx.reply('Отмена месячных снята. Месячные восстановлены, уведомления активированы.', {
          reply_markup: periodMenu(),
        });
        messageIds.set(ctx.chat.id, reply.message_id);
      } else {
        const reply = await ctx.reply('Месячные уже отмечены за сегодня.', { reply_markup: periodMenu() });
        messageIds.set(ctx.chat.id, reply.message_id);
      }
    } else if (callbackData === 'end_period') {
      if (user.menstruation_active) {
        await client.query(
          'INSERT INTO cycles (user_id, date, is_menstruation) VALUES ($1, $2, $3)',
          [user.id, today, true]
        );
        await client.query(
          'UPDATE users SET menstruation_active = false WHERE chat_id = $1',
          [ctx.chat.id]
        );
        schedule.cancelJob(`notification_${ctx.chat.id}`);
        const datesResult = await client.query(
          'SELECT date FROM cycles WHERE user_id = $1 AND is_menstruation = true ORDER BY date DESC',
          [user.id]
        );
        const dates = datesResult.rows.map(row => new Date(row.date));
        const cycleLength = dates.length >= 2 ? (dates[0] - dates[1]) / (1000 * 60 * 60 * 24) : 28;
        const nextPeriod = new Date(dates[0].getTime() + cycleLength * 24 * 60 * 60 * 1000);
        const ovulation = new Date(dates[0].getTime() + (cycleLength / 2) * 24 * 60 * 60 * 1000);
        const reply = await ctx.reply(
          `Месячные завершены.\n` +
          `Следующие месячные: через ${Math.round((nextPeriod - today) / (1000 * 60 * 60 * 24))} дней — ${formatDate(nextPeriod)}\n` +
          `Овуляция: через ${Math.round((ovulation - today) / (1000 * 60 * 60 * 24))} дней — ${formatDate(ovulation)}`,
          { reply_markup: await mainMenu(ctx, user) }
        );
        messageIds.set(ctx.chat.id, reply.message_id);
      } else {
        const reply = await ctx.reply('Месячные не активны.', { reply_markup: await mainMenu(ctx, user) });
        messageIds.set(ctx.chat.id, reply.message_id);
      }
    } else if (callbackData === 'sex') {
      await client.query(
        'INSERT INTO sexual_activities (user_id, date) VALUES ($1, $2)',
        [user.id, today]
      );
      const reply = await ctx.reply('Половой акт отмечен ❤️', {
        reply_markup: user.menstruation_active ? periodMenu() : await mainMenu(ctx, user),
      });
      messageIds.set(ctx.chat.id, reply.message_id);
    } else if (callbackData === 'calendar') {
      const cyclesResult = await client.query(
        'SELECT * FROM cycles WHERE user_id = $1',
        [user.id]
      );
      const allCycles = cyclesResult.rows;
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const cal = new Calendar();
      const currentMonthMatrix = cal.monthDays(now.getFullYear(), now.getMonth());
      const nextMonthMatrix = cal.monthDays(now.getFullYear(), now.getMonth() + 1);

      let visual = `Календарь за ${now.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}:\nпн вт ср чт пт сб вс\n`;
      const daysCurrent = {};
      allCycles.forEach(c => {
        const date = new Date(c.date);
        const cycleDay = date.getDate();
        const cycleMonth = date.getMonth();
        const cycleYear = date.getFullYear();
        if (c.is_menstruation && cycleMonth === now.getMonth() && cycleYear === now.getFullYear()) {
          daysCurrent[cycleDay] = '◾️';
        }
      });

      const ovDaysCurrent = new Set();
      if (allCycles.length >= 2) {
        const sortedDates = allCycles
          .filter(c => c.is_menstruation)
          .map(c => new Date(c.date))
          .sort((a, b) => b - a);
        const d1 = sortedDates[0];
        const d2 = sortedDates[1];
        const avgCycle = (d1 - d2) / (1000 * 60 * 60 * 24);
        const ovDay = new Date(d1.getTime() + (avgCycle / 2) * 24 * 60 * 60 * 1000);
        if (ovDay.getMonth() === now.getMonth() && ovDay.getFullYear() === now.getFullYear()) {
          ovDaysCurrent.add(ovDay.getDate());
        }
        const nextPeriod = new Date(d1.getTime() + avgCycle * 24 * 60 * 60 * 1000);
        const nextOvulation = new Date(d1.getTime() + (avgCycle / 2 + avgCycle) * 24 * 60 * 60 * 1000);
        if (nextPeriod.getMonth() === now.getMonth() && nextPeriod.getFullYear() === now.getFullYear()) {
          daysCurrent[nextPeriod.getDate()] = '◾️';
        }
        if (nextOvulation.getMonth() === now.getMonth() + 1 && nextOvulation.getFullYear() === now.getFullYear()) {
          ovDaysCurrent.add(nextOvulation.getDate());
        }
      }

      currentMonthMatrix.forEach(week => {
        let line = '';
        week.forEach(day => {
          if (day === 0) {
            line += '   ';
          } else if (ovDaysCurrent.has(day)) {
            line += `🔻${day.toString().padStart(2, '0')}`;
          } else if (daysCurrent[day]) {
            line += `${daysCurrent[day]}${day.toString().padStart(2, '0')}`;
          } else {
            line += `▫️${day.toString().padStart(2, '0')}`;
          }
          line += ' ';
        });
        visual += line + '\n';
      });

      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      visual += `\nКалендарь за ${nextMonth.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}:\nпн вт ср чт пт сб вс\n`;
      const daysNext = {};
      const ovDaysNext = new Set();
      if (allCycles.length >= 2) {
        const sortedDates = allCycles
          .filter(c => c.is_menstruation)
          .map(c => new Date(c.date))
          .sort((a, b) => b - a);
        const d1 = sortedDates[0];
        const d2 = sortedDates[1];
        const avgCycle = (d1 - d2) / (1000 * 60 * 60 * 24);
        const nextPeriod = new Date(d1.getTime() + avgCycle * 24 * 60 * 60 * 1000);
        const nextOvulation = new Date(d1.getTime() + (avgCycle / 2 + avgCycle) * 24 * 60 * 60 * 1000);
        if (nextPeriod.getMonth() === now.getMonth() + 1 && nextPeriod.getFullYear() === now.getFullYear()) {
          daysNext[nextPeriod.getDate()] = '◾️';
        }
        if (nextOvulation.getMonth() === now.getMonth() + 1 && nextOvulation.getFullYear() === now.getFullYear()) {
          ovDaysNext.add(nextOvulation.getDate());
        }
      }

      nextMonthMatrix.forEach(week => {
        let line = '';
        week.forEach(day => {
          if (day === 0) {
            line += '   ';
          } else if (ovDaysNext.has(day)) {
            line += `🔻${day.toString().padStart(2, '0')}`;
          } else if (daysNext[day]) {
            line += `${daysNext[day]}${day.toString().padStart(2, '0')}`;
          } else {
            line += `▫️${day.toString().padStart(2, '0')}`;
          }
          line += ' ';
        });
        visual += line + '\n';
      });

      visual += '▫️ - Обычный день\n◾️ - Месячные\n🔻 - Овуляция';
      const reply = await ctx.reply(visual, { reply_markup: user.menstruation_active ? periodMenu() : await mainMenu(ctx, user) });
      messageIds.set(ctx.chat.id, reply.message_id);
    }

    await ctx.answerCallbackQuery();
  } catch (err) {
    logger.error(`Ошибка обработки callback: ${err}`);
  } finally {
    client.release();
  }
});

// Уведомления
const sendNotification = async (bot, chatId) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM users WHERE chat_id = $1',
      [chatId]
    );
    const user = result.rows[0];
    if (user && user.menstruation_active) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const cycleResult = await client.query(
        'SELECT * FROM cycles WHERE user_id = $1 AND date = $2 AND is_menstruation = true',
        [user.id, today]
      );
      const hasPeriodToday = cycleResult.rows.length > 0;
      const reply = await bot.telegram.sendMessage(
        chatId,
        'Пожалуйста, отметьте статус месячных за сегодня:',
        { reply_markup: markDayMenu(hasPeriodToday) }
      );
      messageIds.set(chatId, reply.message_id);
    }
  } finally {
    client.release();
  }
};

// Инициализация
const onStartup = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        chat_id BIGINT UNIQUE NOT NULL,
        username VARCHAR,
        menstruation_active BOOLEAN DEFAULT FALSE,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS cycles (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id),
        date DATE NOT NULL,
        is_menstruation BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS sexual_activities (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id),
        date DATE NOT NULL
      );
    `);
    logger.info('Таблицы созданы или уже существуют');

    scheduler = schedule;
    logger.info('Планировщик инициализирован');
  } catch (err) {
    logger.error(`Ошибка при запуске: ${err}`);
  } finally {
    client.release();
  }
};

// Основной запуск
const main = async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    logger.info('Webhook успешно удалён');
  } catch (err) {
    logger.error(`Ошибка при удалении webhook: ${err}`);
  }
  await onStartup();
  bot.launch();
  logger.info('Бот запущен');
};

main().catch(err => logger.error(`Ошибка запуска бота: ${err}`));