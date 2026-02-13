
export interface User {
  id: string;
  name: string;
  email: string;
  photoURL: string;
  role: 'doctor' | 'staff' | 'admin';
}

export interface Message {
  id: string;
  senderId: string;
  senderName: string;
  senderPhoto: string;
  text: string;
  imageUrl?: string;
  timestamp: number;
  isImportant: boolean;
  readBy: string[];
}

export interface ChatRoom {
  id: string;
  name: string;
  code: string;
  createdBy: string;
  createdAt: number;
  participants: string[];
}

export interface SummaryResponse {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}
