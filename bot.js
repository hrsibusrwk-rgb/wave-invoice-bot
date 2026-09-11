const { Telegraf } = require('telegraf');
const axios = require('axios');

// ==================== 配置区 ====================
const TELEGRAM_BOT_TOKEN = "8957889878:AAGsOwGMnv8dNiSa22Bsl1VbYCAgdzohbNU"; // 换成你的 Token
const WAVE_TOKEN = "wwkkCMFu43erTAzgYEqh8QpyraR9hw";
const WAVE_BUSINESS_ID = "QnVzaW5lc3M6NTYxOWUxNzYtMDNiNi00NjBjLWI0YzItMjY0YTJlZTk4MTdm";
const WAVE_GRAPHQL_URL = "https://gql.waveapps.com/graphql/public";

// 初始化 Telegram 机器人
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// 查询 Wave 发票的函数（已包含发票日期 invoiceDate）
async function searchWaveInvoice(keyword) {
    const query = `
    query($businessId: ID!) {
        business(id: $businessId) {
            invoices(page: 1, pageSize: 30) {
                edges {
                    node {
                        invoiceNumber
                        invoiceDate
                        viewUrl
                        amountDue { value }
                        customer { name }
                    }
                }
            }
        }
    }
    `;

    try {
        const response = await axios.post(WAVE_GRAPHQL_URL, {
            query: query,
            variables: { businessId: WAVE_BUSINESS_ID }
        }, {
            headers: {
                "Authorization": `Bearer ${WAVE_TOKEN}`,
                "Content-Type": "application/json"
            }
        });

        const invoices = response.data.data.business.invoices.edges;
        let matched = [];
        const kw = keyword.toLowerCase().trim();

        for (let edge of invoices) {
            const inv = edge.node;
            const invNum = String(inv.invoiceNumber || '').toLowerCase();
            const custName = inv.customer.name.toLowerCase();
            const amount = String(inv.amountDue.value);

            if (invNum.includes(kw) || custName.includes(kw) || amount.includes(kw)) {
                matched.push({
                    invoiceNumber: inv.invoiceNumber,
                    invoiceDate: inv.invoiceDate,
                    customerName: inv.customer.name,
                    amount: amount,
                    viewUrl: inv.viewUrl
                });
            }
        }
        return matched;
    } catch (error) {
        console.error("Wave Search Error:", error.response?.data || error.message);
        return [];
    }
}

// 英文欢迎语 /start
bot.start((ctx) => {
    ctx.reply("👋 Hello! I am your Wave Invoice Assistant.\n\nYou can search and resend invoices anytime using these commands:\n👉 `#resend [Company Name or Invoice No]`\n👉 `#find [Keyword]`");
});

// 监听所有英文指令
bot.on('text', async (ctx) => {
    const messageText = ctx.message.text;

    // 支持 #resend 或 #find 指令
    if (messageText.startsWith('#resend') || messageText.startsWith('#find')) {
        const keyword = messageText.replace('#resend', '').replace('#find', '').trim();
        
        if (!keyword) {
            await ctx.reply("⚠️ Please provide a keyword. Example: `#resend ABC` or `#resend 6`", { parse_mode: 'Markdown' });
            return;
        }

        await ctx.reply(`🔍 Searching Wave for invoices matching "${keyword}"...`);

        const results = await searchWaveInvoice(keyword);

        if (results.length === 0) {
            await ctx.reply(`❌ No invoice records found for "${keyword}".`);
        } else {
            let replyText = `🎉 **Found the following invoice(s):**\n`;
            results.forEach((inv) => {
                replyText += `\n-------------------\n` +
                             `📄 **Invoice No:** #${inv.invoiceNumber}\n` +
                             `📅 **Date:** ${inv.invoiceDate}\n` +
                             `👤 **Customer:** ${inv.customerName}\n` +
                             `💰 **Amount:** RM${inv.amount}\n` +
                             `🔗 **View Link:** ${inv.viewUrl}\n`;
            });
            await ctx.reply(replyText, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
    }
});

// 启动机器人
bot.launch();
console.log('✅ Telegram Bot successfully started and online (English Version)!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
