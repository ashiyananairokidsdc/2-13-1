
import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit, doc, where, getDocs, updateDoc, arrayUnion, setDoc, Firestore } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, Auth } from 'firebase/auth';
import { User, Message, ChatRoom, SummaryResponse } from './types';
import { summarizeChat } from './geminiService';
import { logToGoogleSheets, processImage } from './storageService';

// 最新のFirebase設定（ユーザー提供の情報を適用）
const firebaseConfig = {
  apiKey: "AIzaSyAZmcdNhtiFZCVfqQJ5y0_b8ksTVXnV0x0",
  authDomain: "project-6387108477327371644.firebaseapp.com",
  projectId: "project-6387108477327371644",
  storageBucket: "project-6387108477327371644.firebasestorage.app",
  messagingSenderId: "400557563341",
  appId: "1:400557563341:web:c9bfaa44da653c75f6f884"
};

const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [db, setDb] = useState<Firestore | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
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

  // Firebase初期化
  useEffect(() => {
    try {
      const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
      const _db = getFirestore(app);
      const _auth = getAuth(app);
      
      setDb(_db);
      setAuth(_auth);

      const unsubscribe = onAuthStateChanged(_auth, async (user) => {
        if (user) {
          const userData: User = {
            id: user.uid,
            name: user.displayName || 'スタッフ',
            email: user.email || '',
            photoURL: user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`,
            role: 'staff'
          };
          setCurrentUser(userData);
          await setDoc(doc(_db, 'users', user.uid), userData, { merge: true });
        } else {
          setCurrentUser(null);
        }
        setIsFirebaseReady(true);
      });

      return () => unsubscribe();
    } catch (err: any) {
      console.error("Firebase Init Error:", err);
      setInitError("Firebaseの接続に失敗しました。");
      setIsFirebaseReady(true);
    }
  }, []);

  const handleLogin = async () => {
    if (!auth) return;
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (e: any) {
      console.error("Login Error:", e);
      alert("ログインに失敗しました。");
    }
  };

  // チャットデータ購読
  useEffect(() => {
    if (!db || !currentUser) return;
    const q = query(collection(db, 'rooms'), where('participants', 'array-contains', currentUser.id));
    return onSnapshot(q, (snapshot) => {
      const roomList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChatRoom));
      setRooms(roomList.sort((a, b) => b.createdAt - a.createdAt));
      if (roomList.length > 0 && !activeRoomId) setActiveRoomId(roomList[0].id);
    });
  }, [db, currentUser]);

  useEffect(() => {
    if (!db || !activeRoomId || !currentUser) return;
    const q = query(collection(db, 'rooms', activeRoomId, 'messages'), orderBy('timestamp', 'asc'), limit(100));
    return onSnapshot(q, (snapshot) => {
      const fetchedMessages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Message));
      setMessages(fetchedMessages);
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [db, activeRoomId, currentUser]);

  const handleSendMessage = async (text?: string, imageUrl?: string) => {
    if (!db || !currentUser || !activeRoomId) return;
    const msgText = text || inputText;
    if (!msgText.trim() && !imageUrl) return;

    try {
      const newMessage = {
        senderId: currentUser.id,
        senderName: currentUser.name,
        senderPhoto: currentUser.photoURL,
        text: msgText,
        imageUrl: imageUrl || null,
        timestamp: Date.now(),
        isImportant: isImportant,
        readBy: [currentUser.id]
      };
      const docRef = await addDoc(collection(db, 'rooms', activeRoomId, 'messages'), newMessage);
      setInputText('');
      setIsImportant(false);
      const currentRoom = rooms.find(r => r.id === activeRoomId);
      if (currentRoom) logToGoogleSheets(currentRoom.name, { ...newMessage, id: docRef.id } as any);
    } catch (e) { console.error(e); }
  };

  const createRoom = async () => {
    if (!db || !currentUser || !newRoomName.trim()) return;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      const docRef = await addDoc(collection(db, 'rooms'), {
        name: newRoomName, code, createdBy: currentUser.id, createdAt: Date.now(), participants: [currentUser.id]
      });
      setActiveRoomId(docRef.id);
      setNewRoomName('');
      setShowCreateModal(false);
    } catch (e) { console.error(e); }
  };

  const joinRoomByCode = async () => {
    if (!db || !currentUser || !joinCode.trim()) return;
    try {
      const q = query(collection(db, 'rooms'), where('code', '==', joinCode.trim().toUpperCase()));
      const snap = await getDocs(q);
      if (snap.empty) {
        alert("コードが正しくありません。");
      } else {
        const roomDoc = snap.docs[0];
        await updateDoc(doc(db, 'rooms', roomDoc.id), { participants: arrayUnion(currentUser.id) });
        setActiveRoomId(roomDoc.id);
        setJoinCode('');
        setShowJoinModal(false);
      }
    } catch (e) { console.error(e); }
  };

  if (!isFirebaseReady) return <div className="h-screen flex items-center justify-center bg-[#0d3b36] text-white">接続中...</div>;

  if (!currentUser) return (
    <div className="h-screen flex items-center justify-center bg-[#0d3b36] p-6">
      <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl max-w-sm w-full text-center">
        <div className="w-20 h-20 bg-teal-600 text-white rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl"><i className="fa-solid fa-tooth text-4xl"></i></div>
        <h1 className="text-2xl font-black mb-8 text-slate-800">なないろチャット</h1>
        <button onClick={handleLogin} className="w-full py-4 bg-teal-600 text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-teal-700 transition-all shadow-lg">
          Googleでログイン
        </button>
      </div>
    </div>
  );

  const activeRoom = rooms.find(r => r.id === activeRoomId);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <aside className={`fixed lg:static inset-y-0 left-0 w-[280px] bg-white border-r flex flex-col z-50 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-6 bg-teal-600 text-white flex justify-between items-center shadow-md">
          <h1 className="text-xl font-black flex items-center gap-2"><i className="fa-solid fa-tooth"></i> なないろ歯科</h1>
        </div>
        <div className="p-4 grid grid-cols-2 gap-2 border-b">
          <button onClick={() => setShowCreateModal(true)} className="py-3 bg-teal-50 text-teal-700 rounded-xl text-xs font-black">作成</button>
          <button onClick={() => setShowJoinModal(true)} className="py-3 bg-slate-100 text-slate-700 rounded-xl text-xs font-black">参加</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {rooms.map(room => (
            <div key={room.id} onClick={() => { setActiveRoomId(room.id); setIsSidebarOpen(false); }} className={`p-4 rounded-2xl cursor-pointer mb-1 transition-all ${activeRoomId === room.id ? 'bg-teal-600 text-white shadow-md' : 'hover:bg-teal-50 text-slate-600'}`}>
              <p className="text-sm font-bold truncate">{room.name}</p>
              <p className="text-[9px] opacity-60 font-mono uppercase">CODE: {room.code}</p>
            </div>
          ))}
        </div>
        <div className="p-4 bg-slate-50 border-t flex items-center gap-3">
          <img src={currentUser.photoURL} className="w-10 h-10 rounded-full border shadow-sm" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-black truncate">{currentUser.name}</p>
            <button onClick={() => signOut(auth!)} className="text-[10px] text-red-500 font-bold">ログアウト</button>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col bg-white">
        <header className="h-16 lg:h-20 border-b flex items-center justify-between px-6 bg-white/90 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden w-10 h-10 flex items-center justify-center text-slate-500 bg-slate-100 rounded-xl"><i className="fa-solid fa-bars text-xl"></i></button>
            <h2 className="font-black text-lg text-slate-800 truncate">{activeRoom?.name || 'ルームを選択'}</h2>
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
              className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-teal-500 to-emerald-600 text-white rounded-xl text-xs font-black shadow-md disabled:opacity-50"
            >
              {isSummarizing ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-magic-sparkles"></i>} AI要約
            </button>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-slate-50/50">
          {messages.map((msg) => {
            const isMe = msg.senderId === currentUser.id;
            return (
              <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''}`}>
                <img src={msg.senderPhoto} className="w-8 h-8 rounded-full self-end mb-1 shadow-sm" />
                <div className={`max-w-[85%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                  {!isMe && <span className="text-[10px] text-slate-400 font-bold mb-1 ml-1">{msg.senderName}</span>}
                  <div className={`p-4 rounded-2xl text-sm shadow-sm relative ${msg.isImportant ? 'bg-amber-50 border-2 border-amber-200 ring-2 ring-amber-100' : isMe ? 'bg-teal-600 text-white rounded-tr-none' : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'}`}>
                    {msg.imageUrl && <img src={msg.imageUrl} className="rounded-xl mb-3 max-w-full border" />}
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                    <div className="text-[9px] opacity-60 mt-2 text-right">
                      {new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="p-4 border-t bg-white">
          <form onSubmit={(e) => { e.preventDefault(); handleSendMessage(); }} className="max-w-4xl mx-auto flex items-end gap-2">
            <button type="button" onClick={() => fileInputRef.current?.click()} className="w-12 h-12 flex items-center justify-center bg-slate-100 text-slate-400 rounded-2xl hover:bg-slate-200 transition-all"><i className="fa-solid fa-camera text-xl"></i></button>
            <input type="file" ref={fileInputRef} onChange={async (e) => {
              const file = e.target.files?.[0];
              if(file) handleSendMessage(undefined, await processImage(file));
            }} className="hidden" accept="image/*" />
            <div className="flex-1 bg-slate-100 rounded-2xl p-2 border border-transparent focus-within:border-teal-400 transition-all">
              <textarea value={inputText} onChange={e => setInputText(e.target.value)} placeholder="メッセージを入力..." rows={1} className="bg-transparent w-full px-3 py-2 outline-none text-sm resize-none" />
              <div className="flex justify-start px-2 pb-1">
                <button type="button" onClick={() => setIsImportant(!isImportant)} className={`text-[10px] px-3 py-1 rounded-full border-2 font-black ${isImportant ? 'bg-amber-400 text-white border-amber-500 shadow-sm' : 'text-slate-400 bg-white border-slate-200'}`}>重要マーク</button>
              </div>
            </div>
            <button type="submit" disabled={!inputText.trim() && !activeRoomId} className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all ${inputText.trim() ? 'bg-teal-600 text-white shadow-lg' : 'bg-slate-200 text-slate-400'}`}><i className="fa-solid fa-paper-plane text-xl"></i></button>
          </form>
        </footer>
      </main>

      {/* モーダル類 */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl animate-in zoom-in">
            <h3 className="font-black text-xl mb-4 text-slate-800 text-center">ルームを新規作成</h3>
            <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)} placeholder="ルーム名を入力" className="w-full p-4 bg-slate-100 rounded-2xl outline-none mb-6 font-bold text-center" autoFocus />
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
            <h3 className="font-black text-xl mb-2 text-slate-800 text-center">ルームに参加</h3>
            <p className="text-xs text-slate-500 mb-6 font-bold text-center">共有された6桁のコードを入力</p>
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
            <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto">
              <div className="bg-teal-50 p-6 rounded-2xl text-sm text-slate-700 italic border-l-4 border-teal-400 leading-relaxed">{summary.summary}</div>
              <div><h4 className="text-[10px] font-black text-amber-600 uppercase mb-3">重要ポイント</h4><ul className="space-y-2">{summary.keyPoints.map((p,i)=><li key={i} className="text-xs flex gap-2 font-bold text-slate-600"><i className="fa-solid fa-circle-check text-amber-500 mt-0.5"></i>{p}</li>)}</ul></div>
              <div><h4 className="text-[10px] font-black text-blue-600 uppercase mb-3">次のアクション</h4><ul className="space-y-2">{summary.actionItems.map((a,i)=><li key={i} className="text-xs flex gap-2 font-bold text-slate-600"><i className="fa-solid fa-arrow-right text-blue-500 mt-0.5"></i>{a}</li>)}</ul></div>
            </div>
            <div className="p-8 bg-slate-50 text-center border-t"><button onClick={()=>setSummary(null)} className="px-12 py-4 bg-white border-2 rounded-2xl font-black text-slate-500 hover:text-teal-600 transition-all shadow-sm">確認しました</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
