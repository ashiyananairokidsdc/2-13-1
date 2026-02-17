
import { GoogleGenAI, Type } from "@google/genai";
import { Message, SummaryResponse } from "./types";

// APIクライアントの初期化（process.env.API_KEYは自動的に注入されます）
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const summarizeChat = async (messages: Message[]): Promise<SummaryResponse> => {
  // メッセージが少なすぎる場合のハンドリング
  if (!messages || messages.length < 3) {
    return {
      summary: "現在、チャットのやり取りが少ないため要約を作成できません。もう少し会話が溜まってから再度お試しください。",
      keyPoints: ["メッセージ数が不足しています"],
      actionItems: ["さらなる情報共有をお待ちしています"]
    };
  }

  // AIに送る履歴を整形（最新の50件程度に絞ることで安定性を向上）
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

【要件】
1. 患者様の状態、予約の変更、器具の準備、スタッフの指示などに注目してください。
2. 専門用語（スケーリング、抜歯、矯正装置など）はそのまま使いつつ、分かりやすくまとめてください。
3. 出力は必ず指定されたJSON形式で行ってください。
  `;

  const prompt = `以下のチャット履歴を要約してください：\n\n${chatHistory}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING, description: '会話の全体像を3行程度でまとめたもの' },
            keyPoints: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: '決定事項や共有すべき事実の箇条書き' 
            },
            actionItems: { 
              type: Type.ARRAY, 
              items: { type: Type.STRING },
              description: 'これから誰が何をする必要があるかのリスト' 
            }
          },
          required: ["summary", "keyPoints", "actionItems"]
        }
      }
    });

    const text = response.text;
    if (!text) {
      console.error("Gemini API returned an empty text response.");
      throw new Error("AIからの応答が空でした。");
    }

    // AIの応答をパース
    try {
      return JSON.parse(text.trim()) as SummaryResponse;
    } catch (parseError) {
      console.error("JSON Parse Error. Raw text:", text);
      throw new Error("AIの応答形式が不正です。");
    }

  } catch (error: any) {
    // コンソールに詳細なエラーを出力（開発者ツールで確認可能）
    console.error("Gemini Summary Error Details:", {
      message: error.message,
      stack: error.stack,
      rawError: error
    });

    return {
      summary: "AI要約の生成中にエラーが発生しました。しばらく時間を置いてから再度お試しください。",
      keyPoints: [`エラー原因: ${error.message || '不明なエラー'}`],
      actionItems: ["インターネット接続を確認する", "APIキーのステータスを確認する"]
    };
  }
};
