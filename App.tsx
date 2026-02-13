
import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit, doc, deleteDoc, where, getDocs } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'firebase/auth';
import { User, Message, ChatRoom, SummaryResponse } from './types';
import { summarizeChat } from './geminiService';
import { logToGoogleSheets, processImage } from './storageService';

const getFirebaseConfig = () => {
  try {
    const rawConfig = (import.meta as any).env?.VITE_FIREBASE_CONFIG || (process as any).env?.FIREBASE_CONFIG;
    if (!rawConfig) return { error: "Firebase設定が見つかりません。" };
    if (typeof rawConfig === 'object') return rawConfig;
    return JSON.parse(rawConfig.match(/\{[\s\S]*\}/)?.[0] || rawConfig);
  } catch (e) {
    return { error: "Firebase設定の解析に失敗しました。" };
  }
};

const firebaseConfig = getFirebaseConfig();

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [db, setDb] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [isFirebaseReady, setIsFirebaseReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  // UI States
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  
  const [inputText, setInputText] = useState('');
  const [isImportant, setIsImportant] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Firebase Initialization
  useEffect(() => {
    if (firebaseConfig && firebaseConfig.apiKey) {
      try {
        const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
        const _db = getFirestore(app);
        const _auth = getAuth(app);
        setDb(_db);
        setAuth(_auth);
        setIsFirebaseReady(true);

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
      } catch (err: any) {
        setInitError(err.message);
      }
    }
  }, []);

  // Rooms Fetching
  useEffect(() => {
    if (!db || !currentUser) return;
    const q = query(collection(db, 'rooms'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const roomList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChatRoom));
      setRooms(roomList);
      if (roomList.length > 0 && !activeRoomId) {
        setActiveRoomId(roomList[0].id);
      }
    });
    return () => unsubscribe();
  }, [db, currentUser]);

  // Messages Fetching
  useEffect(() => {
    if (!db || !activeRoomId) return;
    const q = query(collection(db, 'rooms', activeRoomId, 'messages'), orderBy('timestamp', 'asc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setMessages(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message)));
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
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e: any) {
      alert(`ログイン失敗: ${e.code}\n承認済みドメインを確認してください。`);
    }
  };

  const createRoom = async () => {
    if (!newRoomName.trim() || !currentUser) return;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      await addDoc(collection(db, 'rooms'), {
        name: newRoomName,
        code,
        createdBy: currentUser.id,
        createdAt: Date.now(),
        participants: [currentUser.id]
      });
      setNewRoomName('');
      setShowCreateModal(false);
    } catch (e) {
      alert("ルーム作成に失敗しました。");
    }
  };

  const joinRoomByCode = async () => {
    if (!joinCode.trim()) return;
    const q = query(collection(db, 'rooms'), where('code', '==', joinCode.toUpperCase()));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      alert("該当するコードのルームが見つかりません。");
    } else {
      const roomId = snapshot.docs[0].id;
      setActiveRoomId(roomId);
      setJoinCode('');
      setShowJoinModal(false);
      setIsSidebarOpen(false);
    }
  };

  const deleteRoom = async (roomId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("このルームを削除してもよろしいですか？（メッセージもすべて削除されます）")) return;
    try {
      await deleteDoc(doc(db, 'rooms', roomId));
      if (activeRoomId === roomId) setActiveRoomId('');
    } catch (e) {
      alert("削除に失敗しました。");
    }
  };

  const handleSendMessage = async (e?: React.FormEvent, imageUrl?: string) => {
    if (e) e.preventDefault();
    if (!currentUser || !db || !activeRoomId) return;
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
      logToGoogleSheets(rooms.find(r => r.id === activeRoomId)?.name || 'ルーム', msgData as any);
    } catch (err) {
      console.error(err);
    }
  };

  if (initError) return <div className="p-10 text-red-500 font-bold">Error: {initError}</div>;
  if (!currentUser) return (
    <div className="h-screen flex flex-col items-center justify-center bg-[#0d3b36] p-4 text-center">
      <div className="bg-white p-8 rounded-[2rem] shadow-2xl max-w-sm w-full">
        <div className="w-20 h-20 bg-teal-600 text-white rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl"><i className="fa-solid fa-tooth text-4xl"></i></div>
        <h1 className="text-2xl font-black mb-2">なないろチャット</h1>
        <p className="text-slate-500 mb-8 text-sm">院内連絡用セキュアツール</p>
        <button onClick={handleLogin} className="w-full py-4 bg-teal-600 text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-teal-700 transition active:scale-95 shadow-lg">
          <i className="fa-brands fa-google"></i> Googleログイン
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {/* Sidebar Overlay (Mobile) */}
      {isSidebarOpen && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setIsSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`fixed lg:static inset-y-0 left-0 w-72 bg-white border-r flex flex-col z-50 transition-transform duration-300 transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-5 bg-teal-600 text-white flex justify-between items-center shadow-md">
          <h1 className="text-lg font-bold flex items-center gap-2"><i className="fa-solid fa-tooth"></i> なないろ歯科</h1>
          <button onClick={() => signOut(auth)} className="text-[10px] bg-white/20 px-2 py-1 rounded hover:bg-white/30">ログアウト</button>
        </div>
        
        <div className="p-3 grid grid-cols-2 gap-2">
          <button onClick={() => setShowCreateModal(true)} className="flex items-center justify-center gap-1 py-2 bg-teal-50 text-teal-700 rounded-xl text-xs font-bold hover:bg-teal-100 transition"><i className="fa-solid fa-plus"></i> 作成</button>
          <button onClick={() => setShowJoinModal(true)} className="flex items-center justify-center gap-1 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-200 transition"><i className="fa-solid fa-key"></i> 参加</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {rooms.map(room => (
            <div
              key={room.id}
              onClick={() => { setActiveRoomId(room.id); setIsSidebarOpen(false); }}
              className={`group w-full p-4 flex items-center justify-between border-b cursor-pointer transition ${activeRoomId === room.id ? 'bg-teal-50 border-l-4 border-teal-500' : 'hover:bg-slate-50 border-l-4 border-transparent'}`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold flex-shrink-0 ${activeRoomId === room.id ? 'bg-teal-600 text-white' : 'bg-teal-100 text-teal-600'}`}>{room.name[0]}</div>
                <div className="overflow-hidden">
                  <p className="text-sm font-bold truncate text-slate-700">{room.name}</p>
                  <p className="text-[10px] text-slate-400 font-mono">CODE: {room.code}</p>
                </div>
              </div>
              {room.createdBy === currentUser.id && (
                <button onClick={(e) => deleteRoom(room.id, e)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 p-1"><i className="fa-solid fa-trash-can text-xs"></i></button>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col bg-white">
        <header className="h-16 border-b flex items-center justify-between px-4 lg:px-6 bg-white shadow-sm z-20">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden w-10 h-10 flex items-center justify-center text-slate-500 rounded-lg hover:bg-slate-100"><i className="fa-solid fa-bars-staggered text-xl"></i></button>
            <h2 className="font-bold text-slate-700 truncate max-w-[150px] sm:max-w-none">{rooms.find(r => r.id === activeRoomId)?.name || 'ルームを選択'}</h2>
          </div>
          <button 
            onClick={async () => {
              setIsSummarizing(true);
              const res = await summarizeChat(messages);
              setSummary(res);
              setIsSummarizing(false);
            }}
            disabled={isSummarizing || messages.length === 0}
            className="flex items-center gap-2 px-3 py-2 bg-teal-500 text-white rounded-full text-[12px] sm:text-sm font-bold shadow-lg hover:bg-teal-600 disabled:opacity-50 transition-all active:scale-95"
          >
            {isSummarizing ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-magic-sparkles"></i>}
            <span className="hidden sm:inline">AI要約</span>
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50">
          {!activeRoomId && <div className="h-full flex flex-col items-center justify-center text-slate-300"><i className="fa-solid fa-comments text-5xl mb-4 opacity-20"></i><p>ルームを作成するか参加してください</p></div>}
          {messages.map((msg, i) => {
            const isMe = msg.senderId === currentUser.id;
            return (
              <div key={msg.id} className={`flex gap-2 ${isMe ? 'flex-row-reverse' : ''} animate-in fade-in duration-300`}>
                <img src={msg.senderPhoto} className="w-8 h-8 rounded-full border border-white shadow-sm self-end" />
                <div className={`max-w-[85%] sm:max-w-[70%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                  <div className="flex gap-2 px-1 mb-0.5"><span className="text-[9px] font-bold text-slate-400">{msg.senderName}</span></div>
                  <div className={`p-3 rounded-2xl text-sm shadow-sm relative ${msg.isImportant ? 'bg-amber-50 border border-amber-200 ring-2 ring-amber-100' : isMe ? 'bg-teal-600 text-white' : 'bg-white text-slate-700 border border-slate-100'}`}>
                    {msg.imageUrl && <img src={msg.imageUrl} className="rounded-lg mb-2 max-w-full" onClick={() => window.open(msg.imageUrl)}/>}
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                    <span className={`text-[8px] mt-1 block ${isMe ? 'text-teal-200' : 'text-slate-400'}`}>{new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="p-3 sm:p-4 bg-white border-t border-slate-100">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex items-end gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} className="w-11 h-11 flex items-center justify-center bg-slate-50 text-slate-400 rounded-xl hover:bg-slate-100"><i className="fa-solid fa-camera"></i></button>
            <input type="file" ref={fileInputRef} onChange={async (e) => {
              const file = e.target.files?.[0];
              if(file) handleSendMessage(undefined, await processImage(file));
            }} className="hidden" accept="image/*" />
            
            <div className="flex-1 bg-slate-50 rounded-2xl p-2 border border-slate-200 focus-within:ring-2 focus-within:ring-teal-100">
              <textarea
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                placeholder="送信..."
                rows={1}
                className="bg-transparent w-full p-2 outline-none text-sm resize-none"
                onKeyDown={e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }}}
              />
              <button type="button" onClick={() => setIsImportant(!isImportant)} className={`text-[10px] px-2 py-0.5 rounded-full border transition ${isImportant ? 'bg-amber-400 text-white border-amber-500' : 'text-slate-400 bg-white border-slate-200'}`}>重要!</button>
            </div>
            <button type="submit" disabled={!inputText.trim() && !activeRoomId} className={`w-11 h-11 rounded-xl flex items-center justify-center transition ${inputText.trim() ? 'bg-teal-600 text-white shadow-lg' : 'bg-slate-100 text-slate-300'}`}><i className="fa-solid fa-paper-plane"></i></button>
          </form>
        </footer>
      </main>

      {/* Modals */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="font-bold text-lg mb-4">新しいルームを作成</h3>
            <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)} placeholder="例：受付連絡" className="w-full p-4 bg-slate-100 rounded-2xl outline-none focus:ring-2 focus:ring-teal-400 mb-4" />
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)} className="flex-1 py-3 font-bold text-slate-400">キャンセル</button>
              <button onClick={createRoom} className="flex-1 py-3 bg-teal-600 text-white rounded-2xl font-bold">作成する</button>
            </div>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="font-bold text-lg mb-4">ルームに参加</h3>
            <p className="text-xs text-slate-400 mb-4">共有された6桁のコードを入力してください</p>
            <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={6} placeholder="ABCDEF" className="w-full p-4 bg-slate-100 rounded-2xl outline-none focus:ring-2 focus:ring-teal-400 mb-4 text-center font-mono text-xl tracking-widest" />
            <div className="flex gap-3">
              <button onClick={() => setShowJoinModal(false)} className="flex-1 py-3 font-bold text-slate-400">閉じる</button>
              <button onClick={joinRoomByCode} className="flex-1 py-3 bg-teal-600 text-white rounded-2xl font-bold">参加する</button>
            </div>
          </div>
        </div>
      )}

      {/* AI Summary Modal */}
      {summary && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg shadow-2xl overflow-hidden animate-in zoom-in duration-300">
            <div className="p-6 bg-teal-600 text-white flex justify-between items-center">
              <div className="flex items-center gap-3"><i className="fa-solid fa-sparkles text-2xl"></i><h3 className="font-bold">AI 要約</h3></div>
              <button onClick={() => setSummary(null)} className="w-8 h-8 flex items-center justify-center bg-white/20 rounded-full hover:bg-white/30"><i className="fa-solid fa-xmark"></i></button>
            </div>
            <div className="p-8 space-y-6 max-h-[70vh] overflow-y-auto">
              <div className="bg-teal-50 p-4 rounded-2xl border border-teal-100 text-sm text-slate-700 leading-relaxed italic">{summary.summary}</div>
              <div><h4 className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-2">重要ポイント</h4><ul className="space-y-2">{summary.keyPoints.map((p,i)=><li key={i} className="text-xs flex gap-2"><i className="fa-solid fa-circle-check text-amber-500 mt-1"></i>{p}</li>)}</ul></div>
              <div><h4 className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-2">次のアクション</h4><ul className="space-y-2">{summary.actionItems.map((a,i)=><li key={i} className="text-xs flex gap-2"><i className="fa-solid fa-arrow-right text-blue-500 mt-1"></i>{a}</li>)}</ul></div>
            </div>
            <div className="p-6 bg-slate-50 text-center"><button onClick={()=>setSummary(null)} className="px-12 py-3 bg-white border border-slate-200 rounded-2xl font-bold hover:bg-slate-100 transition shadow-sm">閉じる</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
