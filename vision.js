// vision.js —— 用 Claude 的视觉能力，把 Excel 截图读成结构化数据。
// 需要在 Render 环境变量里设置 ANTHROPIC_API_KEY（去 console.anthropic.com 申请）。

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// 如果想省成本，可以把下面的 model 换成 "claude-haiku-4-5-20251001"（便宜很多，
// 对付格式规整的表格截图通常也够用）；金额/公司名要求高准确度的话，保留 sonnet。
const VISION_MODEL = process.env.INVOICE_VISION_MODEL || "claude-sonnet-5";

const EXTRACT_TOOL = {
    name: "record_invoice_data",
    description: "记录从截图中识别出的、用来开发票的明细数据",
    input_schema: {
        type: "object",
        properties: {
            companyName: {
                type: "string",
                description: "截图里 'Company Name' 那一栏的内容，也就是这张发票要 Bill To 的客户名字，原样抄录，不要翻译、不要自己补全或改写"
            },
            items: {
                type: "array",
                description: "表格里每一行有效数据（跳过空行、跳过合计/总计行）",
                items: {
                    type: "object",
                    properties: {
                        item: { type: "string", description: "Item 栏位内容（产品/服务名称）" },
                        description: { type: "string", description: "Description 栏位内容" },
                        qty: { type: "number", description: "QTY 数量，纯数字" },
                        price: { type: "number", description: "Price 单价，纯数字，不带货币符号、不带千分位逗号" }
                    },
                    required: ["item", "description", "qty", "price"]
                }
            }
        },
        required: ["companyName", "items"]
    }
};

const EXTRACT_PROMPT = `这是一张 Excel 表格的截图，内容是用来开发票的明细。
请把 "Company Name" 的值，以及表格里每一行的 Item / Description / QTY / Price 原样抄录出来，
调用 record_invoice_data 工具记录下来。
注意：
- QTY 和 Price 只填数字，不要带 "RM"、逗号等符号。
- 如果某一行是空行、表头行、或者是合计/总计行，跳过，不要当成一个 item。
- 数字看不清楚的话，按截图里最像的数字填，不要自己编造。`;

async function extractInvoiceFromImage(imageBuffer, mimeType = "image/jpeg") {
    const base64 = imageBuffer.toString("base64");

    const response = await anthropic.messages.create({
        model: VISION_MODEL,
        max_tokens: 2048,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: "tool", name: "record_invoice_data" },
        messages: [{
            role: "user",
            content: [
                { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
                { type: "text", text: EXTRACT_PROMPT }
            ]
        }]
    });

    const toolUse = response.content.find(b => b.type === "tool_use");
    if (!toolUse) {
        throw new Error("AI 没能从图片里识别出结构化数据，换一张更清晰的截图试试。");
    }
    return toolUse.input; // { companyName, items: [{item, description, qty, price}] }
}

module.exports = { extractInvoiceFromImage };
