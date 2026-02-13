
import { GoogleGenAI, Type } from "@google/genai";
import { Message, SummaryResponse } from "./types";

// Always use const ai = new GoogleGenAI({apiKey: process.env.API_KEY});
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const summarizeChat = async (messages: Message[]): Promise<SummaryResponse> => {
  const chatHistory = messages
    .map(m => `${m.senderName}: ${m.text}${m.isImportant ? ' [重要]' : ''}`)
    .join('\n');

  const prompt = `
    以下の院内チャットの履歴を、医療チーム向けに要約してください。
    
    チャット履歴:
    ${chatHistory}
    
    要約のポイント:
    1. 全体の流れを簡潔に
    2. 決定事項や重要なポイントを抽出
    3. 次のアクション（誰が何をすべきか）を明確に
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING, description: '全体要約' },
            keyPoints: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: '重要ポイント' 
            },
            actionItems: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: '次へのアクション' 
            }
          },
          required: ["summary", "keyPoints", "actionItems"]
        }
      }
    });

    const text = response.text;
    if (!text) {
      throw new Error("Empty response from AI");
    }
    return JSON.parse(text.trim()) as SummaryResponse;
  } catch (error) {
    console.error("Gemini Error:", error);
    return {
      summary: "要約の生成に失敗しました。",
      keyPoints: ["エラーが発生しました"],
      actionItems: []
    };
  }
};
