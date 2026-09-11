const { Telegraf } = require('telegraf');
const axios = require('axios');
const http = require('http'); // 引入内置的 http 模块来满足 Render 端口要求

// ==================== 配置区 ====================
const TELEGRAM_BOT_TOKEN = "8957889878:AAGsOwGMnv8dNiSa22Bsl1VbYCAgdzohbNU"; 
const WAVE_GRAPHQL_URL = "https://gql.waveapps.com/graphql/public";

// 在这里配置你的多账号列表
const WAVE_ACCOUNTS = [
    {
        name: "Company A",
        businessId: "BShYHGI-JLVa9PcPvw311D_48dQ2a54onv2Isvfw",
        token: "O1bIO4eiS7otNo8JAUwOcCUfFv1wLv"
    },
    {
        name: "Company B",
        businessId: "F8Ac4.DfkbU.RpLXYPaKnQ4hv3YpdQWiz5Ill_ZT",
        token: "CuF67Ugju7HR0w4UU9x41p9IeKpYdj"
    }
];

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function searchWaveInvoice(keywordInput) {
    const keywords = keywordInput.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let allMatched = [];

    const promises = WAVE_ACCOUNTS.map(async (acc) => {
        const query = `
        query($businessId: ID!) {
            business(id: $businessId) {
                invoices(page: 1, pageSize: 50) {
                    edges {
                        node {
                            invoiceNumber
                            invoiceDate
                            paidDate
                            status
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
                variables: { businessId: acc.businessId }
            }, {
                headers: {
                    "Authorization": `Bearer ${acc.token}`,
                    "Content-Type": "application/json"
                }
            });

            if (!response.data || !response.data.data || !response.data.data.business) {
                return [];
            }

            const invoices = response.data.data.business.invoices.edges;
            const matched = [];

            for (let edge of invoices) {
                const inv = edge.node;
                const invNum = String(inv.invoiceNumber || '').toLowerCase();
                const custName = inv.customer.name.toLowerCase();
                const amount = String(inv.amountDue.value || '').toLowerCase();
                const status = String(inv.status || '').toLowerCase();
                const invoiceDate = String(inv.invoiceDate || '').toLowerCase();
                const paidDate = String(inv.paidDate || '').toLowerCase();

                const combinedFields = `${invNum} ${custName} ${amount} ${status} ${invoiceDate} ${paidDate}`;
                const isMatchAll = keywords.every(kw => combinedFields.includes(kw));

                if (isMatchAll) {
                    matched.push({
                        accountName: acc.name,
                        invoiceNumber: inv.invoiceNumber,
                        invoiceDate: inv.invoiceDate,
                        paidDate: inv.paidDate || 'N/A',
                        status: inv.status,
                        customerName: inv.customer.name,
                        amount: amount,
                        viewUrl: inv.viewUrl
                    });
                }
            }
            return matched;
        } catch (error) {
            console.error(`Wave Search Error for ${acc.name}:`, error.response?.data || error.message);
            return [];
        }
    });

    const resultsArrays = await Promise.all(promises);
    for (const arr of resultsArrays) {
        allMatched.push(...arr);
    }
    
    return allMatched;
}

bot.start((ctx) => {
    ctx.reply("👋 Hello! Multi-Account Wave Assistant is ready.");
});

bot.on('text', async (ctx) => {
    const messageText = ctx.message.text;

    if (messageText.startsWith('#resend') || messageText.startsWith('#find')) {
        const keyword = messageText.replace('#resend', '').replace('#find', '').trim();
        
        if (!keyword) {
            await ctx.reply("⚠️ Please provide a keyword. Example: `#resend abc 2026-06`", { parse_mode: 'Markdown' });
            return;
        }

        await ctx.reply(`🔍 Searching across all independent Wave accounts for: "${keyword}"...`);

        const results = await searchWaveInvoice(keyword);

        if (results.length === 0) {
            await ctx.reply(`❌ No invoice records found matching all conditions for "${keyword}".`);
        } else {
            let replyText = `🎉 **Found the following invoice(s):**\n`;
            results.forEach((inv) => {
                replyText += `\n-------------------\n` +
                             `🏢 **Account:** ${inv.accountName}\n` +
                             `📄 **Invoice No:** #${inv.invoiceNumber}\n` +
                             `🏷️ **Status:** ${inv.status}\n` +
                             `📅 **Invoice Date:** ${inv.invoiceDate}\n` +
                             `💳 **Paid Date:** ${inv.paidDate}\n` +
                             `👤 **Customer:** ${inv.customerName}\n` +
                             `💰 **Amount:** RM${inv.amount}\n` +
                             `🔗 **View Link:** ${inv.viewUrl}\n`;
            });
            await ctx.reply(replyText, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }
    }
});

bot.launch();
console.log('✅ Telegram Bot successfully started and online!');

// 启动一个微型 HTTP 服务器，专门用来通过 Render 的端口扫描，并响应 UptimeRobot 的 ping 唤醒
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive and running!');
}).listen(PORT, () => {
    console.log(`HTTP server is listening on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
