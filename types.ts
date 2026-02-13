
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
  readBy: string[]; // User IDs
}

export interface ChatRoom {
  id: string;
  name: string;
  code: string;
  participants: string[]; // User IDs
  lastMessage?: string;
  lastTimestamp?: number;
  unreadCount?: number;
}

export interface SummaryResponse {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}
