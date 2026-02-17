
import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit, doc, where, getDocs, updateDoc, arrayUnion, setDoc } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, Auth } from 'firebase/auth';
import { User, Message, ChatRoom, SummaryResponse } from './types';
import { summarizeChat } from './geminiService';
import { logToGoogleSheets, processImage } from './storageService';

// Firebase設定の取得（Vite / Node 両対応）
const getFirebaseConfig = () => {
  try {
    const rawConfig = (import.meta as any).env?.VITE_FIREBASE_CONFIG || (process as any).env?.FIREBASE_CONFIG;
    if (!rawConfig) return { error: "Firebase設定が見つかりません。環境変数 FIREBASE_CONFIG を確認してください。" };
    if (typeof rawConfig === 'object') return rawConfig;
    const parsed = JSON.parse(rawConfig.match(/\{[\s\S]*\}/)?.[0] || rawConfig);
    if (!parsed.apiKey) return { error: "Firebase設定が不完全です（apiKeyがありません）。" };
    return parsed;
  } catch (e) {
    return { error: "Firebase設定の解析に失敗しました。JSON形式が正しいか確認してください。" };
  }
};

const firebaseConfig = getFirebaseConfig();

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [db, setDb] = useState<any>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [isFirebaseReady, setIsFirebaseReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(firebaseConfig.error || null);

  // API Key Selection State
  const [hasApiKey, setHasApiKey] = useState<boolean>(true);

  // UI States
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  
  const [inputText, setInputText] = useState('');
  const [isImportant, setIsImportant] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // APIキーの有無をチェック
  useEffect(() => {
    const checkKey = async () => {
      if (typeof (window as any).aistudio?.hasSelectedApiKey === 'function') {
        const selected = await (window as any).aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      }
    };
    checkKey();
  }, [currentUser]);

  const handleOpenSelectKey = async () => {
    if (typeof (window as any).aistudio?.openSelectKey === 'function') {
      await (window as any).aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  // Firebase初期化
  useEffect(() => {
    if (!firebaseConfig.apiKey) return;

    try {
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
      const _db = getFirestore(app);
      const _auth = getAuth(app);
      
      setDb(_db);
      setAuth(_auth);

      onAuthStateChanged(_auth, async (user) => {
        if (user) {
          const userData: User = {
            id: user.uid,
            name: user.displayName || '名無しスタッフ',
            email: user.email || '',
            photoURL: user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`,
            role: 'staff'
          };
          setCurrentUser(userData);
          await setDoc(doc(_db, 'users', user.uid), userData, { merge: true });
        } else {
          setCurrentUser(null);
        }
        setIsFirebaseReady(true); // 認証状態の確認が終わってからReadyとする
      });
    } catch (err: any) {
      console.error("Firebase Init Error:", err);
      setInitError("Firebaseの初期化中にエラーが発生しました: " + err.message);
    }
  }, []);

  // ログイン処理
  const handleLogin = async () => {
    if (!auth) {
      alert("認証システムが準備できていません。しばらく待っても改善しない場合は、ページを再読み込みしてください。");
      return;
    }
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (e: any) {
      console.error("Login Error:", e);
      if (e.code === 'auth/popup-blocked') {
        alert("ポップアップがブロックされました。ブラウザの設定で許可してください。");
      } else {
        alert("ログインに失敗しました: " + e.message);
      }
    }
  };

  // ルーム一覧の取得
  useEffect(() => {
    if (!db || !currentUser) return;
    const q = query(collection(db, 'rooms'), where('participants', 'array-contains', currentUser.id));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const roomList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChatRoom));
      roomList.sort((a, b) => b.createdAt - a.createdAt);
      setRooms(roomList);
      if (roomList.length > 0 && !activeRoomId) setActiveRoomId(roomList[0].id);
    });
    return () => unsubscribe();
  }, [db, currentUser]);

  // メッセージの取得
  useEffect(() => {
    if (!db || !activeRoomId || !currentUser) return;
    const q = query(collection(db, 'rooms', activeRoomId, 'messages'), orderBy('timestamp', 'asc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedMessages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
      setMessages(fetchedMessages);
      fetchedMessages.forEach(async (msg) => {
        if (msg.senderId !== currentUser.id && !msg.readBy.includes(currentUser.id)) {
          await updateDoc(doc(db, 'rooms', activeRoomId, 'messages', msg.id), {
            readBy: arrayUnion(currentUser.id)
          });
        }
      });
    });
    return () => unsubscribe();
  }, [db, activeRoomId, currentUser]);

  const handleSendMessage = async (text?: string, imageUrl?: string) => {
    if (!db || !currentUser || !activeRoomId) return;
    const msgText = text || inputText;
    if (!msgText.trim() && !imageUrl) return;

    const newMessage: Omit<Message, 'id'> = {
      senderId: currentUser.id,
      senderName: currentUser.name,
      senderPhoto: currentUser.photoURL,
      text: msgText,
      imageUrl: imageUrl || undefined,
      timestamp: Date.now(),
      isImportant: isImportant,
      readBy: [currentUser.id]
    };

    try {
      const docRef = await addDoc(collection(db, 'rooms', activeRoomId, 'messages'), newMessage);
      setInputText('');
      setIsImportant(false);
      const currentRoom = rooms.find(r => r.id === activeRoomId);
      if (currentRoom) logToGoogleSheets(currentRoom.name, { ...newMessage, id: docRef.id });
    } catch (e) { console.error("Error sending message:", e); }
  };

  const createRoom = async () => {
    if (!db || !currentUser || !newRoomName.trim()) return;
    setIsProcessing(true);
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      const docRef = await addDoc(collection(db, 'rooms'), {
        name: newRoomName, code, createdBy: currentUser.id, createdAt: Date.now(), participants: [currentUser.id]
      });
      setActiveRoomId(docRef.id);
      setNewRoomName('');
      setShowCreateModal(false);
    } catch (e) { console.error(e); } finally { setIsProcessing(false); }
  };

  const joinRoomByCode = async () => {
    if (!db || !currentUser || !joinCode.trim()) return;
    setIsProcessing(true);
    try {
      const q = query(collection(db, 'rooms'), where('code', '==', joinCode.trim().toUpperCase()));
      const snap = await getDocs(q);
      if (snap.empty) alert("ルームが見つかりません。");
      else {
        const roomDoc = snap.docs[0];
        await updateDoc(doc(db, 'rooms', roomDoc.id), { participants: arrayUnion(currentUser.id) });
        setActiveRoomId(roomDoc.id);
        setJoinCode('');
        setShowJoinModal(false);
      }
    } catch (e) { console.error(e); } finally { setIsProcessing(false); }
  };

  // ログイン画面
  if (!currentUser) return (
    <div className="h-screen flex items-center justify-center bg-[#0d3b36] p-6 text-center">
      <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl max-w-sm w-full">
        <div className="w-20 h-20 bg-teal-600 text-white rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl animate-in zoom-in">
          <i className="fa-solid fa-tooth text-4xl"></i>
        </div>
        <h1 className="text-2xl font-black mb-2 text-slate-800">なないろチャット</h1>
        <p className="text-slate-500 mb-8 text-sm font-bold">院内連絡用 Pro</p>

        {initError ? (
          <div className="p-4 bg-red-50 text-red-600 rounded-2xl text-xs font-bold leading-relaxed border border-red-100">
            <i className="fa-solid fa-triangle-exclamation mb-2 text-lg"></i>
            <p>{initError}</p>
          </div>
        ) : !isFirebaseReady ? (
          <div className="py-4 text-slate-400 font-bold flex flex-col items-center gap-3">
            <i className="fa-solid fa-circle-notch animate-spin text-2xl"></i>
            <p className="text-xs">サーバーに接続中...</p>
          </div>
        ) : (
          <button 
            type="button"
            onClick={handleLogin} 
            className="w-full py-4 bg-teal-600 text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-teal-700 active:scale-95 shadow-lg transition-all"
          >
            <i className="fa-brands fa-google text-lg"></i> Googleでログイン
          </button>
        )}
      </div>
    </div>
  );

  // APIキー設定画面
  if (!hasApiKey) return (
    <div className="h-screen flex items-center justify-center bg-slate-900 p-6 text-center">
      <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl max-w-sm w-full">
        <div className="w-20 h-20 bg-amber-500 text-white rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl"><i className="fa-solid fa-key text-4xl"></i></div>
        <h1 className="text-2xl font-black mb-4 text-slate-800">APIキーの設定</h1>
        <p className="text-slate-500 mb-8 text-sm font-bold">AI機能を使用するにはAPIキーの選択が必要です。</p>
        <button onClick={handleOpenSelectKey} className="w-full py-4 bg-amber-500 text-white rounded-2xl font-black shadow-lg active:scale-95 transition-all mb-4">
          APIキーを選択する
        </button>
        <button onClick={() => signOut(auth!)} className="text-xs text-slate-400 font-bold hover:text-red-500">ログアウトして戻る</button>
      </div>
    </div>
  );

  const activeRoom = rooms.find(r => r.id === activeRoomId);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans select-none">
      {/* Sidebar */}
      {isSidebarOpen && <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 lg:hidden" onClick={() => setIsSidebarOpen(false)} />}
      <aside className={`fixed lg:static inset-y-0 left-0 w-[280px] bg-white border-r flex flex-col z-50 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-6 bg-teal-600 text-white flex justify-between items-center shadow-md">
          <h1 className="text-xl font-black flex items-center gap-2"><i className="fa-solid fa-tooth"></i> なないろ歯科</h1>
          <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden text-white/80"><i className="fa-solid fa-xmark text-xl"></i></button>
        </div>
        <div className="p-4 grid grid-cols-2 gap-2">
          <button onClick={() => setShowCreateModal(true)} className="flex items-center justify-center gap-2 py-3 bg-teal-50 text-teal-700 rounded-xl text-xs font-black hover:bg-teal-100 transition shadow-sm">作成</button>
          <button onClick={() => setShowJoinModal(true)} className="flex items-center justify-center gap-2 py-3 bg-slate-100 text-slate-700 rounded-xl text-xs font-black hover:bg-slate-200 transition shadow-sm">参加</button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          <div className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">ルーム一覧</div>
          {rooms.map(room => (
            <div key={room.id} onClick={() => { setActiveRoomId(room.id); setIsSidebarOpen(false); }} className={`group w-full p-4 flex items-center justify-between rounded-2xl cursor-pointer transition-all ${activeRoomId === room.id ? 'bg-teal-600 text-white shadow-lg' : 'hover:bg-teal-50 text-slate-600'}`}>
              <div className="flex items-center gap-3 overflow-hidden">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center font-black ${activeRoomId === room.id ? 'bg-white/20' : 'bg-teal-100 text-teal-600'}`}>{room.name[0]}</div>
                <div className="overflow-hidden text-left"><p className="text-sm font-bold truncate">{room.name}</p><p className="text-[9px] font-mono opacity-60">CODE: {room.code}</p></div>
              </div>
            </div>
          ))}
        </div>
        <div className="p-4 bg-slate-50 border-t flex items-center gap-3">
          <img src={currentUser.photoURL} className="w-10 h-10 rounded-full border-2 border-white shadow-sm" alt="User"/>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-black text-slate-700 truncate">{currentUser.name}</p>
            <button onClick={() => signOut(auth!)} className="text-[9px] font-bold text-red-500">ログアウト</button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col bg-white relative">
        <header className="h-16 lg:h-20 border-b flex items-center justify-between px-4 lg:px-8 bg-white/90 backdrop-blur-md sticky top-0 z-30 shadow-sm">
          <div className="flex items-center gap-4 overflow-hidden">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden w-10 h-10 flex items-center justify-center text-slate-500 bg-slate-100 rounded-xl"><i className="fa-solid fa-bars-staggered text-xl"></i></button>
            <div className="overflow-hidden">
              <h2 className="font-black text-lg text-slate-800 truncate mb-1 leading-none">{activeRoom?.name || 'ルームを選択してください'}</h2>
              {activeRoom && <p className="text-[10px] text-teal-600 font-bold font-mono">CODE: {activeRoom.code}</p>}
            </div>
          </div>
          {activeRoom && (
            <button 
              onClick={async () => {
                setIsSummarizing(true);
                const res = await summarizeChat(messages);
                setSummary(res);
                setIsSummarizing(false);
              }}
              disabled={isSummarizing || messages.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-teal-500 to-emerald-600 text-white rounded-2xl text-[12px] sm:text-sm font-black shadow-lg disabled:opacity-50 transition-all active:scale-95"
            >
              {isSummarizing ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-magic-sparkles"></i>}
              <span>AI要約</span>
            </button>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-6 bg-slate-50/50 scroll-smooth">
          {rooms.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center p-8">
              <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center mb-6 animate-pulse opacity-30"><i className="fa-solid fa-comments text-5xl"></i></div>
              <h3 className="font-black text-lg text-slate-600 mb-2">ルームがありません</h3>
              <p className="text-sm">「作成」ボタンから新しいチャットルームを作ってください。</p>
            </div>
          ) : !activeRoomId ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 italic"><p>サイドバーからルームを選択してください</p></div>
          ) : (
            messages.map((msg) => {
              const isMe = msg.senderId === currentUser.id;
              const readCount = msg.readBy.filter(id => id !== msg.senderId).length;
              return (
                <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                  <img src={msg.senderPhoto} className="w-8 h-8 rounded-full border-2 border-white shadow-sm self-end mb-1" />
                  <div className={`max-w-[85%] sm:max-w-[70%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    <span className="text-[9px] font-black text-slate-400 mb-1 px-1">{msg.senderName}</span>
                    <div className={`p-4 rounded-[1.5rem] text-[13px] sm:text-sm shadow-sm relative ${msg.isImportant ? 'bg-amber-50 border-2 border-amber-200 ring-4 ring-amber-100/30' : isMe ? 'bg-teal-600 text-white rounded-tr-none' : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'}`}>
                      {msg.isImportant && <span className="absolute -top-2 -left-2 bg-amber-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-[10px] shadow-md border-2 border-white font-black">!</span>}
                      {msg.imageUrl && <img src={msg.imageUrl} className="rounded-xl mb-3 max-w-full border border-slate-100" onClick={() => window.open(msg.imageUrl)}/>}
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                      <div className={`flex items-center gap-2 mt-2 ${isMe ? 'flex-row-reverse justify-start' : 'justify-end'}`}>
                        {readCount > 0 && <span className={`text-[8px] font-black ${isMe ? 'text-teal-200' : 'text-slate-400'}`}>既読 {readCount}</span>}
                        <div className={`text-[8px] font-bold ${isMe ? 'text-teal-200' : 'text-slate-400'}`}>{new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <footer className="p-4 sm:p-6 bg-white border-t border-slate-100">
          <form onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }} className="max-w-4xl mx-auto flex items-end gap-3">
            <button type="button" onClick={() => fileInputRef.current?.click()} className="w-12 h-12 flex items-center justify-center bg-slate-50 text-slate-400 rounded-2xl hover:bg-slate-100 border border-slate-100 transition-all"><i className="fa-solid fa-camera text-xl"></i></button>
            <input type="file" ref={fileInputRef} onChange={async (e) => {
              const file = e.target.files?.[0];
              if(file) handleSendMessage(undefined, await processImage(file));
            }} className="hidden" accept="image/*" />
            <div className="flex-1 bg-slate-50 rounded-[1.5rem] p-2 border border-slate-200 focus-within:border-teal-400 transition-all">
              <textarea value={inputText} onChange={e => setInputText(e.target.value)} placeholder="メッセージを入力..." rows={1} className="bg-transparent w-full px-3 py-2 outline-none text-sm resize-none" onKeyDown={e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }}} />
              <div className="flex justify-between items-center px-2 pb-1">
                <button type="button" onClick={() => setIsImportant(!isImportant)} className={`text-[10px] px-3 py-1 rounded-full border-2 font-black transition-all ${isImportant ? 'bg-amber-400 text-white border-amber-500' : 'text-slate-400 bg-white border-slate-200'}`}>重要マーク</button>
              </div>
            </div>
            <button type="submit" disabled={!inputText.trim() || !activeRoomId} className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${inputText.trim() ? 'bg-teal-600 text-white shadow-lg' : 'bg-slate-100 text-slate-300'}`}><i className="fa-solid fa-paper-plane text-xl"></i></button>
          </form>
        </footer>
      </main>

      {/* Modals */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl animate-in zoom-in">
            <h3 className="font-black text-xl mb-4 text-slate-800">ルームを作成</h3>
            <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)} placeholder="例：受付連絡、オペ室" className="w-full p-4 bg-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-teal-100 mb-6 font-bold" autoFocus />
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)} className="flex-1 py-4 font-black text-slate-400">閉じる</button>
              <button onClick={createRoom} className="flex-1 py-4 bg-teal-600 text-white rounded-2xl font-black shadow-lg">作成</button>
            </div>
          </div>
        </div>
      )}

      {showJoinModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl animate-in zoom-in">
            <h3 className="font-black text-xl mb-2 text-slate-800">ルームに参加</h3>
            <p className="text-xs text-slate-500 mb-6 font-bold">6桁の招待コードを入力してください</p>
            <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={6} placeholder="ABCDEF" className="w-full p-5 bg-slate-100 rounded-2xl outline-none mb-6 text-center font-mono text-3xl font-black" />
            <div className="flex gap-3">
              <button onClick={() => setShowJoinModal(false)} className="flex-1 py-4 font-black text-slate-400">閉じる</button>
              <button onClick={joinRoomByCode} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black shadow-lg">参加</button>
            </div>
          </div>
        </div>
      )}

      {summary && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg shadow-2xl overflow-hidden animate-in zoom-in">
            <div className="p-8 bg-teal-600 text-white flex justify-between items-center"><h3 className="font-black text-lg">AI 業務要約</h3><button onClick={() => setSummary(null)} className="w-10 h-10 flex items-center justify-center bg-white/10 rounded-full"><i className="fa-solid fa-xmark"></i></button></div>
            <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto bg-white">
              <div className="bg-teal-50 p-6 rounded-[2rem] text-sm text-slate-700 italic border-l-4 border-teal-400 shadow-inner">{summary.summary}</div>
              {summary.keyPoints[0]?.includes("エラー原因") && (
                <div className="p-4 bg-red-50 text-red-600 rounded-2xl border border-red-200">
                  <p className="text-xs font-bold mb-3">APIエラーが発生しました。キーを再設定してください。</p>
                  <button onClick={handleOpenSelectKey} className="w-full py-3 bg-red-600 text-white rounded-xl text-xs font-black">APIキーを再選択</button>
                </div>
              )}
              <div><h4 className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-3">重要ポイント</h4><ul className="space-y-2">{summary.keyPoints.map((p,i)=><li key={i} className="text-xs flex gap-2 font-bold text-slate-600"><i className="fa-solid fa-circle-check text-amber-500 mt-0.5"></i>{p}</li>)}</ul></div>
              <div><h4 className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-3">次のアクション</h4><ul className="space-y-2">{summary.actionItems.map((a,i)=><li key={i} className="text-xs flex gap-2 font-bold text-slate-600"><i className="fa-solid fa-arrow-right text-blue-500 mt-0.5"></i>{a}</li>)}</ul></div>
            </div>
            <div className="p-8 bg-slate-50 text-center border-t"><button onClick={()=>setSummary(null)} className="px-16 py-4 bg-white border-2 border-slate-200 rounded-2xl font-black text-slate-500 hover:text-teal-600 transition-all">確認しました</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
