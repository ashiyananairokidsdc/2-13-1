
import { GoogleGenAI, Type } from "@google/genai";
import { Message, SummaryResponse } from "./types";

export const summarizeChat = async (messages: Message[]): Promise<SummaryResponse> => {
  // 関数の実行直前にインスタンス化することで、最新のprocess.env.API_KEYを使用
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  if (!messages || messages.length < 3) {
    return {
      summary: "現在、チャットのやり取りが少ないため要約を作成できません。もう少し会話が溜まってから再度お試しください。",
      keyPoints: ["メッセージ数が不足しています"],
      actionItems: ["さらなる情報共有をお待ちしています"]
    };
  }

  const chatHistory = messages
    .slice(-50)
    .map(m => {
      const role = m.senderName;
      const text = m.text || (m.imageUrl ? "[画像が送信されました]" : "");
      const imp = m.isImportant ? " [重要]" : "";
      return `${role}: ${text}${imp}`;
    })
    .join('\n');

  const systemInstruction = `
あなたは歯科医院「なないろ歯科」の優秀なチーフスタッフです。
提供されたスタッフ間のチャット履歴を分析し、多忙な院長や他のスタッフが10秒で状況を把握できるよう要約してください。
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `以下のチャット履歴を要約してください：\n\n${chatHistory}`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            keyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
            actionItems: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["summary", "keyPoints", "actionItems"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("AIからの応答が空でした。");

    return JSON.parse(text.trim()) as SummaryResponse;

  } catch (error: any) {
    console.error("Gemini Error:", error);
    
    let errorMsg = error.message || "不明なエラー";
    if (errorMsg.includes("API key not valid")) {
      errorMsg = "APIキーが無効です。支払い設定を確認するか、キーを再選択してください。";
    }

    return {
      summary: "AI要約の生成中にエラーが発生しました。",
      keyPoints: [`エラー原因: ${errorMsg}`],
      actionItems: ["APIキーの設定を再確認する", "Google Cloudの支払い設定を確認する"]
    };
  }
};
