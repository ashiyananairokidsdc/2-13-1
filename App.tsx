
import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';
import { User, Message, ChatRoom, SummaryResponse } from './types';
// Vite環境での解決を助けるため、パスを再確認
import { summarizeChat } from './services/geminiService';
import { logToGoogleSheets, processImage } from './services/storageService';

// Firebase設定のパースエラーを防ぐ
const getFirebaseConfig = () => {
  try {
    // FIX: Access process.env and import.meta.env with any casting to satisfy TS error
    const config = (process as any).env?.FIREBASE_CONFIG || (import.meta as any).env?.VITE_FIREBASE_CONFIG;
    return config ? JSON.parse(config) : null;
  } catch (e) {
    console.error("Firebase config parse error:", e);
    return null;
  }
};

const firebaseConfig = getFirebaseConfig();

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [db, setDb] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);

  const [rooms] = useState<ChatRoom[]>([
    { id: 'all', name: '全体掲示板', code: 'NANA01', participants: [] }
  ]);
  const [activeRoomId, setActiveRoomId] = useState<string>('all');
  const [messages, setMessages] = useState<Message[]>([]);
  
  const [inputText, setInputText] = useState('');
  const [isImportant, setIsImportant] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (firebaseConfig && firebaseConfig.apiKey) {
      const app = initializeApp(firebaseConfig);
      const _db = getFirestore(app);
      const _auth = getAuth(app);
      setDb(_db);
      setAuth(_auth);

      onAuthStateChanged(_auth, (user) => {
        if (user) {
          setCurrentUser({
            id: user.uid,
            name: user.displayName || '名無しスタッフ',
            email: user.email || '',
            photoURL: user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`,
            role: 'staff'
          });
        } else {
          setCurrentUser(null);
        }
      });
    }
  }, []);

  useEffect(() => {
    if (!db || !activeRoomId) return;

    const q = query(
      collection(db, 'rooms', activeRoomId, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    // FIX: Explicitly cast snapshot to any to bypass Property 'docs' does not exist error
    const unsubscribe = onSnapshot(q, (snapshot: any) => {
      const newMessages = snapshot.docs.map((doc: any) => ({
        id: doc.id,
        ...doc.data()
      })) as Message[];
      setMessages(newMessages);
    }, (error) => {
      console.error("Firestore sync error:", error);
    });

    return () => unsubscribe();
  }, [db, activeRoomId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleLogin = async () => {
    if (!auth) return alert("Firebase設定が読み込めていません。Vercelの環境変数設定を確認してください。");
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error("Login error:", e);
      alert("ログインに失敗しました。");
    }
  };

  const handleSendMessage = async (e?: React.FormEvent, imageUrl?: string) => {
    if (e) e.preventDefault();
    if (!currentUser || !db) return;
    if (!inputText.trim() && !imageUrl) return;

    const msgData = {
      senderId: currentUser.id,
      senderName: currentUser.name,
      senderPhoto: currentUser.photoURL,
      text: inputText,
      imageUrl: imageUrl || null,
      timestamp: Date.now(),
      isImportant: isImportant,
      readBy: [currentUser.id]
    };

    try {
      await addDoc(collection(db, 'rooms', activeRoomId, 'messages'), msgData);
      setInputText('');
      setIsImportant(false);
      logToGoogleSheets(rooms.find(r => r.id === activeRoomId)?.name || '全体', { ...msgData, id: 'temp' } as any);
    } catch (err) {
      console.error("Error adding message:", err);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const base64 = await processImage(file);
        handleSendMessage(undefined, base64);
      } catch (err) {
        alert("画像の処理に失敗しました。");
      }
    }
  };

  const runSummary = async () => {
    if (messages.length === 0) return;
    setIsSummarizing(true);
    try {
      const res = await summarizeChat(messages);
      setSummary(res);
    } catch (err) {
      console.error("Summary error:", err);
      alert("AI要約に失敗しました。APIキーの設定を確認してください。");
    } finally {
      setIsSummarizing(false);
    }
  };

  if (!currentUser) {
    return (
      <div className="h-screen flex items-center justify-center bg-teal-600">
        <div className="bg-white p-10 rounded-3xl shadow-2xl text-center max-w-sm w-full mx-4">
          <i className="fa-solid fa-tooth text-6xl text-teal-500 mb-6"></i>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">なないろチャット</h1>
          <p className="text-slate-500 mb-8">院内専用の安全な連絡ツール</p>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-white border-2 border-slate-200 rounded-xl font-bold flex items-center justify-center gap-3 hover:bg-slate-50 transition shadow-sm"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5" />
            Googleでログイン
          </button>
          {!firebaseConfig && (
            <p className="mt-4 text-xs text-red-500 bg-red-50 p-2 rounded">
              Firebaseの設定が見つかりません。<br/>環境変数 FIREBASE_CONFIG を設定してください。
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <aside className="w-72 bg-white border-r flex flex-col shadow-lg z-30">
        <div className="p-5 bg-teal-600 text-white flex justify-between items-center">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <i className="fa-solid fa-tooth"></i> なないろ
          </h1>
          <button onClick={() => auth.signOut()} className="text-xs opacity-70 hover:opacity-100">ログアウト</button>
        </div>
        <div className="flex-1 overflow-y-auto mt-4">
          {rooms.map(room => (
            <button
              key={room.id}
              onClick={() => setActiveRoomId(room.id)}
              className={`w-full p-4 flex items-center gap-3 border-b hover:bg-slate-50 transition ${activeRoomId === room.id ? 'bg-teal-50 border-l-4 border-teal-500' : ''}`}
            >
              <div className="w-10 h-10 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center font-bold">
                {room.name[0]}
              </div>
              <div className="text-left overflow-hidden">
                <p className="font-bold text-sm truncate">{room.name}</p>
                <p className="text-[10px] text-slate-400">招待コード: {room.code}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="p-4 bg-slate-100 flex items-center gap-3">
          <img src={currentUser.photoURL} className="w-8 h-8 rounded-full border border-white shadow-sm" alt="User"/>
          <div className="text-xs">
            <p className="font-bold truncate w-40">{currentUser.name}</p>
            <p className="text-slate-500 font-mono text-[9px]">ID: {currentUser.id.substring(0,8)}</p>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col bg-white relative">
        <header className="h-16 border-b px-6 flex items-center justify-between bg-white/90 backdrop-blur-sm shadow-sm">
          <h2 className="text-lg font-bold text-slate-700">{rooms.find(r => r.id === activeRoomId)?.name}</h2>
          <button 
            onClick={runSummary}
            disabled={isSummarizing || messages.length === 0}
            className={`flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-blue-500 to-teal-500 text-white rounded-full text-sm font-bold shadow-md hover:scale-105 transition disabled:opacity-50`}
          >
            {isSummarizing ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-magic-sparkles"></i>}
            AI要約
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-slate-300">
              <i className="fa-regular fa-comments text-4xl mb-2"></i>
              <p className="text-sm">メッセージはありません</p>
            </div>
          )}
          {messages.map(msg => {
            const isMe = msg.senderId === currentUser.id;
            return (
              <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                <img src={msg.senderPhoto} className="w-8 h-8 rounded-full self-end shadow-sm" alt="Sender"/>
                <div className={`max-w-[70%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                  <div className="flex gap-2 items-center mb-1">
                    <span className="text-[10px] font-bold text-slate-500">{msg.senderName}</span>
                    <span className="text-[9px] text-slate-400">{new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                  </div>
                  <div className={`
                    p-3 rounded-2xl shadow-sm text-sm relative
                    ${msg.isImportant ? 'bg-amber-50 border-2 border-amber-300 ring-2 ring-amber-100' : isMe ? 'bg-teal-600 text-white' : 'bg-white text-slate-700'}
                  `}>
                    {msg.isImportant && <i className="fa-solid fa-circle-exclamation text-amber-500 absolute -top-2 -left-2 bg-white rounded-full p-0.5 shadow-sm"></i>}
                    {msg.imageUrl && <img src={msg.imageUrl} className="max-w-full rounded-lg mb-2 border cursor-pointer" onClick={() => window.open(msg.imageUrl)} alt="Attached"/>}
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </div>
                  <div className="mt-1 flex gap-2">
                    <span className="text-[9px] text-slate-400">既読 {msg.readBy?.length || 1}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="p-4 bg-white border-t">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex items-end gap-3">
            <button 
              type="button" 
              onClick={() => fileInputRef.current?.click()}
              className="w-10 h-10 flex items-center justify-center bg-slate-100 text-slate-500 rounded-full hover:bg-slate-200 transition"
            >
              <i className="fa-solid fa-camera"></i>
            </button>
            <input type="file" ref={fileInputRef} onChange={onFileChange} className="hidden" accept="image/*" />
            
            <div className="flex-1 bg-slate-100 rounded-2xl p-2 flex flex-col">
              <textarea
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                rows={1}
                placeholder="メッセージを入力..."
                className="bg-transparent w-full p-2 outline-none text-sm resize-none"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
              />
              <div className="flex justify-between items-center px-1">
                <button 
                  type="button"
                  onClick={() => setIsImportant(!isImportant)}
                  className={`text-[10px] px-2 py-1 rounded-full font-bold transition ${isImportant ? 'bg-amber-400 text-white shadow-sm' : 'text-slate-400 bg-slate-200 hover:bg-slate-300'}`}
                >
                  <i className="fa-solid fa-triangle-exclamation mr-1"></i>重要
                </button>
              </div>
            </div>

            <button 
              type="submit"
              disabled={!inputText.trim()}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg transition ${inputText.trim() ? 'bg-teal-600 text-white hover:bg-teal-700' : 'bg-slate-200 text-slate-400'}`}
            >
              <i className="fa-solid fa-paper-plane"></i>
            </button>
          </form>
        </footer>

        {summary && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 text-slate-800">
            <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
              <div className="p-5 bg-teal-600 text-white flex justify-between items-center">
                <h3 className="font-bold flex items-center gap-2"><i className="fa-solid fa-sparkles"></i> AI 要約レポート</h3>
                <button onClick={() => setSummary(null)} className="hover:rotate-90 transition"><i className="fa-solid fa-xmark"></i></button>
              </div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                <div className="bg-teal-50 p-4 rounded-xl border border-teal-100">
                  <p className="text-sm leading-relaxed">{summary.summary}</p>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-amber-600 mb-2 uppercase tracking-widest">重要ポイント</h4>
                  <ul className="space-y-1">
                    {summary.keyPoints.map((k, i) => (
                      <li key={i} className="text-sm flex gap-2"><i className="fa-solid fa-check text-amber-500 mt-1"></i> {k}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-blue-600 mb-2 uppercase tracking-widest">ネクストアクション</h4>
                  <ul className="space-y-1">
                    {summary.actionItems.map((a, i) => (
                      <li key={i} className="text-sm flex gap-2"><i className="fa-solid fa-arrow-right text-blue-500 mt-1"></i> {a}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="p-4 border-t text-center">
                <button onClick={() => setSummary(null)} className="px-6 py-2 bg-slate-100 rounded-full font-bold text-slate-500 hover:bg-slate-200 transition">閉じる</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
