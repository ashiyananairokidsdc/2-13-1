
import { Message } from "./types";

export const logToGoogleSheets = async (roomName: string, message: Message) => {
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbxQuhRIYcoZs1ON4wOQRKq66qv7vyeUHWSgsoE7LG2RZOE7gF7jnplwlBSUaZz4zr-t7Q/exec'; 
  
  try {
    await fetch(GAS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room: roomName,
        user: message.senderName,
        text: message.text,
        important: message.isImportant
      })
    });
  } catch (e) {
    console.error("Sheets log error:", e);
  }
};

export const processImage = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 400; 
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH;
        canvas.height = img.height * scaleSize;
        
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};
