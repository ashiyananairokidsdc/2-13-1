
import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'firebase/auth';
import { User, Message, ChatRoom, SummaryResponse } from './types';
import { summarizeChat } from './geminiService';
import { logToGoogleSheets, processImage } from './storageService';

const getFirebaseConfig = () => {
  try {
    const envConfig = (process as any).env?.FIREBASE_CONFIG || (import.meta as any).env?.VITE_FIREBASE_CONFIG;
    if (!envConfig) return null;
    return typeof envConfig === 'string' ? JSON.parse(envConfig) : envConfig;
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
  const [isFirebaseReady, setIsFirebaseReady] = useState(false);

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
      try {
        const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
        const _db = getFirestore(app);
        const _auth = getAuth(app);
        setDb(_db);
        setAuth(_auth);
        setIsFirebaseReady(true);

        const unsubscribe = onAuthStateChanged(_auth, (user) => {
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
        return () => unsubscribe();
      } catch (err) {
        console.error("Firebase Init Error:", err);
      }
    }
  }, []);

  useEffect(() => {
    if (!db || !activeRoomId) return;

    const q = query(
      collection(db, 'rooms', activeRoomId, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const newMessages = snapshot.docs.map((doc) => ({
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
    if (!auth) return;
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error("Login error:", e);
      alert("ログインに失敗しました。");
    }
  };

  const handleLogout = () => {
    if (auth) signOut(auth);
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

  if (!isFirebaseReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-teal-600 p-4 text-center">
        <div className="bg-white p-8 rounded-3xl shadow-2xl max-w-md w-full">
          <i className="fa-solid fa-triangle-exclamation text-amber-500 text-5xl mb-4"></i>
          <h2 className="text-xl font-bold mb-4">Firebase未設定</h2>
          <p className="text-slate-600 text-sm mb-6 leading-relaxed">
            Firebaseの接続設定が見つかりません。Vercelの環境変数に <b>FIREBASE_CONFIG</b> を設定してください。
          </p>
          <div className="bg-slate-50 p-4 rounded-xl text-left font-mono text-xs overflow-x-auto border">
            {`{"apiKey": "...", "authDomain": "...", ...}`}
          </div>
          <p className="mt-6 text-[10px] text-slate-400 italic">
            ※Firebase Console > プロジェクト設定 > マイアプリ から取得できます。
          </p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="h-screen flex items-center justify-center bg-teal-600">
        <div className="bg-white p-10 rounded-3xl shadow-2xl text-center max-w-sm w-full mx-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="w-20 h-20 bg-teal-100 rounded-full flex items-center justify-center mx-auto mb-6 text-teal-600">
            <i className="fa-solid fa-tooth text-4xl"></i>
          </div>
          <h1 className="text-2xl font-bold text-slate-800 mb-2">なないろチャット</h1>
          <p className="text-slate-500 mb-8">なないろ歯科・こども矯正歯科<br/>院内専用 連絡ツール</p>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-white border-2 border-slate-200 rounded-xl font-bold flex items-center justify-center gap-3 hover:bg-slate-50 hover:border-teal-500 transition-all shadow-sm"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-5" alt="Google"/>
            Googleでログイン
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <aside className="w-72 bg-white border-r flex flex-col shadow-lg z-30 transition-all">
        <div className="p-5 bg-teal-600 text-white flex justify-between items-center shadow-md">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <i className="fa-solid fa-tooth"></i> なないろ歯科
          </h1>
          <button onClick={handleLogout} className="text-[10px] bg-teal-700/50 px-2 py-1 rounded-md hover:bg-teal-800 transition">ログアウト</button>
        </div>
        <div className="flex-1 overflow-y-auto pt-2">
          {rooms.map(room => (
            <button
              key={room.id}
              onClick={() => setActiveRoomId(room.id)}
              className={`w-full p-4 flex items-center gap-3 border-b hover:bg-slate-50 transition ${activeRoomId === room.id ? 'bg-teal-50 border-l-4 border-teal-500' : 'border-l-4 border-transparent'}`}
            >
              <div className="w-10 h-10 bg-teal-100 text-teal-600 rounded-full flex items-center justify-center font-bold">
                {room.name[0]}
              </div>
              <div className="text-left overflow-hidden">
                <p className="font-bold text-sm truncate text-slate-700">{room.name}</p>
                <p className="text-[10px] text-slate-400">招待コード: {room.code}</p>
              </div>
            </button>
          ))}
        </div>
        <div className="p-4 bg-slate-50 border-t flex items-center gap-3">
          <img src={currentUser.photoURL} className="w-9 h-9 rounded-full border-2 border-white shadow-sm" alt="User"/>
          <div className="text-xs overflow-hidden">
            <p className="font-bold text-slate-700 truncate">{currentUser.name}</p>
            <p className="text-slate-400 text-[10px] truncate">{currentUser.email}</p>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col bg-white relative">
        <header className="h-16 border-b px-6 flex items-center justify-between bg-white/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-teal-100 text-teal-600 rounded-lg flex items-center justify-center">
              <i className="fa-solid fa-comments"></i>
            </div>
            <h2 className="text-lg font-bold text-slate-700">{rooms.find(r => r.id === activeRoomId)?.name}</h2>
          </div>
          <button 
            onClick={runSummary}
            disabled={isSummarizing || messages.length === 0}
            className={`flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-teal-500 to-emerald-500 text-white rounded-full text-sm font-bold shadow-lg hover:shadow-teal-200 transition-all hover:scale-105 disabled:opacity-50 disabled:scale-100`}
          >
            {isSummarizing ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-magic-sparkles"></i>}
            AI要約
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50 scroll-smooth">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 animate-pulse">
              <i className="fa-regular fa-comments text-6xl mb-4"></i>
              <p className="text-sm">まだメッセージがありません。<br/>会話を始めてみましょう！</p>
            </div>
          )}
          {messages.map((msg, index) => {
            const isMe = msg.senderId === currentUser.id;
            const prevMsg = messages[index - 1];
            const isSameSender = prevMsg && prevMsg.senderId === msg.senderId;
            
            return (
              <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''} ${isSameSender ? 'mt-[-1rem]' : ''} group animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                {!isSameSender ? (
                  <img src={msg.senderPhoto} className="w-9 h-9 rounded-full self-start shadow-sm border border-white" alt="Avatar"/>
                ) : (
                  <div className="w-9"></div>
                )}
                <div className={`max-w-[75%] ${isMe ? 'items-end' : 'items-start'} flex flex-col`}>
                  {!isSameSender && (
                    <div className="flex gap-2 items-center mb-1 px-1">
                      <span className="text-[10px] font-bold text-slate-500">{msg.senderName}</span>
                      <span className="text-[9px] text-slate-400">{new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                    </div>
                  )}
                  <div className={`
                    p-3 rounded-2xl shadow-sm text-[13px] leading-relaxed relative
                    ${msg.isImportant ? 'bg-amber-50 border border-amber-300 ring-4 ring-amber-400/10' : isMe ? 'bg-teal-600 text-white' : 'bg-white text-slate-700 border border-slate-100'}
                  `}>
                    {msg.isImportant && (
                      <span className="absolute -top-2 -left-2 bg-amber-500 text-white w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm border border-white font-bold">
                        !
                      </span>
                    )}
                    {msg.imageUrl && (
                      <img 
                        src={msg.imageUrl} 
                        className="max-w-full rounded-xl mb-2 border border-slate-200 cursor-zoom-in hover:opacity-95 transition" 
                        onClick={() => window.open(msg.imageUrl)} 
                        alt="添付画像"
                      />
                    )}
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </div>
                  <div className={`mt-1 flex gap-2 transition opacity-0 group-hover:opacity-100 ${isMe ? 'flex-row-reverse' : ''}`}>
                    <span className="text-[9px] text-slate-400">既読 {msg.readBy?.length || 1}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="p-4 bg-white border-t border-slate-100 shadow-[0_-4px_20px_rgba(0,0,0,0.03)]">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex items-end gap-3">
            <button 
              type="button" 
              onClick={() => fileInputRef.current?.click()}
              className="w-12 h-12 flex items-center justify-center bg-slate-50 text-slate-400 rounded-2xl hover:bg-slate-100 hover:text-teal-600 transition-all border border-slate-100"
              title="画像を添付"
            >
              <i className="fa-solid fa-camera text-xl"></i>
            </button>
            <input type="file" ref={fileInputRef} onChange={onFileChange} className="hidden" accept="image/*" />
            
            <div className="flex-1 bg-slate-50 rounded-2xl p-2 border border-slate-100 focus-within:border-teal-300 focus-within:ring-2 focus-within:ring-teal-100 transition-all">
              <textarea
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                rows={1}
                placeholder="なないろチャットにメッセージ..."
                className="bg-transparent w-full p-2 outline-none text-[13px] resize-none max-h-32"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
              />
              <div className="flex justify-between items-center px-2 mt-1">
                <button 
                  type="button"
                  onClick={() => setIsImportant(!isImportant)}
                  className={`text-[9px] px-3 py-1 rounded-full font-bold transition-all border ${isImportant ? 'bg-amber-400 text-white border-amber-500 shadow-sm' : 'text-slate-400 bg-white border-slate-200 hover:bg-slate-50'}`}
                >
                  <i className="fa-solid fa-triangle-exclamation mr-1"></i>重要
                </button>
                <span className="text-[9px] text-slate-300">Shift+Enterで改行</span>
              </div>
            </div>

            <button 
              type="submit"
              disabled={!inputText.trim()}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg transition-all ${inputText.trim() ? 'bg-teal-600 text-white hover:bg-teal-700 hover:scale-105 active:scale-95' : 'bg-slate-100 text-slate-300'}`}
            >
              <i className="fa-solid fa-paper-plane text-xl"></i>
            </button>
          </form>
        </footer>

        {summary && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 text-slate-800">
            <div className="bg-white rounded-[2rem] w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-300">
              <div className="p-6 bg-teal-600 text-white flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                    <i className="fa-solid fa-wand-magic-sparkles"></i>
                  </div>
                  <div>
                    <h3 className="font-bold leading-tight">AI 要約レポート</h3>
                    <p className="text-[10px] opacity-80">現在の会話から作成されました</p>
                  </div>
                </div>
                <button onClick={() => setSummary(null)} className="w-8 h-8 flex items-center justify-center bg-white/10 rounded-full hover:bg-white/20 transition"><i className="fa-solid fa-xmark"></i></button>
              </div>
              <div className="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
                <section>
                  <div className="bg-teal-50 p-5 rounded-2xl border border-teal-100 relative">
                    <p className="text-sm leading-relaxed text-slate-700">{summary.summary}</p>
                    <i className="fa-solid fa-quote-right absolute bottom-3 right-4 text-teal-200/50 text-2xl"></i>
                  </div>
                </section>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <section>
                    <h4 className="text-[10px] font-black text-amber-600 mb-3 uppercase tracking-tighter flex items-center gap-2">
                      <span className="w-1 h-3 bg-amber-400 rounded-full"></span> 重要ポイント
                    </h4>
                    <ul className="space-y-2">
                      {summary.keyPoints.map((k, i) => (
                        <li key={i} className="text-[12px] flex gap-2 leading-relaxed text-slate-600">
                          <i className="fa-solid fa-circle-check text-amber-500 mt-1 flex-shrink-0"></i> {k}
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h4 className="text-[10px] font-black text-blue-600 mb-3 uppercase tracking-tighter flex items-center gap-2">
                      <span className="w-1 h-3 bg-blue-400 rounded-full"></span> 次のアクション
                    </h4>
                    <ul className="space-y-2">
                      {summary.actionItems.map((a, i) => (
                        <li key={i} className="text-[12px] flex gap-2 leading-relaxed text-slate-600">
                          <i className="fa-solid fa-arrow-right text-blue-500 mt-1 flex-shrink-0"></i> {a}
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              </div>
              <div className="p-6 border-t border-slate-50 bg-slate-50/50 text-center">
                <button onClick={() => setSummary(null)} className="px-10 py-3 bg-white border border-slate-200 rounded-2xl font-bold text-slate-500 hover:bg-slate-100 hover:text-teal-600 transition-all shadow-sm">
                  確認しました
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
