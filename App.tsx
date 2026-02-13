
import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, limit, doc, deleteDoc, where, getDocs, updateDoc, arrayUnion } from 'firebase/firestore';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from 'firebase/auth';
import { User, Message, ChatRoom, SummaryResponse } from './types';
import { summarizeChat } from './geminiService';
import { logToGoogleSheets, processImage } from './storageService';

const getFirebaseConfig = () => {
  try {
    const rawConfig = (import.meta as any).env?.VITE_FIREBASE_CONFIG || (process as any).env?.FIREBASE_CONFIG;
    if (!rawConfig) return { error: "Firebase設定が見つかりません。VercelのEnvironment Variablesを確認してください。" };
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

  // Initialize Firebase
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

  // Fetch Joined Rooms Only
  useEffect(() => {
    if (!db || !currentUser) return;
    // 自分が参加者リスト(participants)に含まれているルームのみを取得
    const q = query(
      collection(db, 'rooms'), 
      where('participants', 'array-contains', currentUser.id),
      orderBy('createdAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const roomList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ChatRoom));
      setRooms(roomList);
      if (roomList.length > 0 && !activeRoomId) {
        setActiveRoomId(roomList[0].id);
      }
    });
    return () => unsubscribe();
  }, [db, currentUser]);

  // Fetch Messages for active room
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
      alert("ログイン失敗: 承認済みドメインを確認してください。");
    }
  };

  const createRoom = async () => {
    if (!newRoomName.trim() || !currentUser) return;
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    try {
      const docRef = await addDoc(collection(db, 'rooms'), {
        name: newRoomName,
        code,
        createdBy: currentUser.id,
        createdAt: Date.now(),
        participants: [currentUser.id] // 作成者を自動的に参加者に追加
      });
      setActiveRoomId(docRef.id);
      setNewRoomName('');
      setShowCreateModal(false);
      setIsSidebarOpen(false);
    } catch (e) {
      alert("ルーム作成に失敗しました。");
    }
  };

  const joinRoomByCode = async () => {
    if (!joinCode.trim() || !currentUser) return;
    const q = query(collection(db, 'rooms'), where('code', '==', joinCode.toUpperCase()));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      alert("該当するコードのルームが見つかりません。");
    } else {
      const roomDoc = snapshot.docs[0];
      const roomId = roomDoc.id;
      const roomData = roomDoc.data();

      // すでに参加していないかチェック
      if (roomData.participants && roomData.participants.includes(currentUser.id)) {
        setActiveRoomId(roomId);
        alert("すでにご参加いただいているルームです。");
      } else {
        // 参加者リストに追加
        await updateDoc(doc(db, 'rooms', roomId), {
          participants: arrayUnion(currentUser.id)
        });
        setActiveRoomId(roomId);
        alert("ルームに参加しました！");
      }
      setJoinCode('');
      setShowJoinModal(false);
      setIsSidebarOpen(false);
    }
  };

  const deleteRoom = async (roomId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("このルームを削除しますか？")) return;
    try {
      await deleteDoc(doc(db, 'rooms', roomId));
      if (activeRoomId === roomId) setActiveRoomId('');
    } catch (e) {
      alert("削除に失敗しました。作成者のみ削除可能です。");
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
      const room = rooms.find(r => r.id === activeRoomId);
      logToGoogleSheets(room?.name || 'ルーム', msgData as any);
    } catch (err) {
      console.error(err);
    }
  };

  if (initError) return <div className="p-10 text-red-500 font-bold bg-white h-screen">Error: {initError}</div>;
  
  if (!currentUser) return (
    <div className="h-screen flex items-center justify-center bg-[#0d3b36] p-6 text-center">
      <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl max-w-sm w-full animate-in fade-in zoom-in duration-500">
        <div className="w-20 h-20 bg-teal-600 text-white rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-xl"><i className="fa-solid fa-tooth text-4xl"></i></div>
        <h1 className="text-2xl font-black mb-2 text-slate-800">なないろチャット</h1>
        <p className="text-slate-500 mb-8 text-sm">院内連絡用 Pro</p>
        <button onClick={handleLogin} className="w-full py-4 bg-teal-600 text-white rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-teal-700 active:scale-95 shadow-lg">
          <i className="fa-brands fa-google text-lg"></i> Googleログイン
        </button>
      </div>
    </div>
  );

  const activeRoom = rooms.find(r => r.id === activeRoomId);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans select-none">
      {/* Sidebar Overlay */}
      {isSidebarOpen && <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-40 lg:hidden" onClick={() => setIsSidebarOpen(false)} />}

      {/* Sidebar */}
      <aside className={`fixed lg:static inset-y-0 left-0 w-[280px] bg-white border-r flex flex-col z-50 transition-transform duration-300 ease-in-out shadow-2xl lg:shadow-none ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-6 bg-teal-600 text-white flex justify-between items-center shadow-md">
          <h1 className="text-xl font-black flex items-center gap-2 tracking-tight"><i className="fa-solid fa-tooth"></i> なないろ歯科</h1>
          <button onClick={() => setIsSidebarOpen(false)} className="lg:hidden text-white/80"><i className="fa-solid fa-xmark text-xl"></i></button>
        </div>
        
        <div className="p-4 grid grid-cols-2 gap-2">
          <button onClick={() => setShowCreateModal(true)} className="flex items-center justify-center gap-2 py-3 bg-teal-50 text-teal-700 rounded-xl text-xs font-black hover:bg-teal-100 transition active:scale-95 shadow-sm">
            <i className="fa-solid fa-plus-circle"></i> 作成
          </button>
          <button onClick={() => setShowJoinModal(true)} className="flex items-center justify-center gap-2 py-3 bg-slate-100 text-slate-700 rounded-xl text-xs font-black hover:bg-slate-200 transition active:scale-95 shadow-sm">
            <i className="fa-solid fa-key"></i> 参加
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 space-y-1">
          <div className="px-4 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">参加中のルーム</div>
          {rooms.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-xs text-slate-400 italic">参加しているルームが<br/>ありません</p>
            </div>
          )}
          {rooms.map(room => (
            <div
              key={room.id}
              onClick={() => { setActiveRoomId(room.id); setIsSidebarOpen(false); }}
              className={`group w-full p-4 flex items-center justify-between rounded-2xl cursor-pointer transition-all ${activeRoomId === room.id ? 'bg-teal-600 text-white shadow-lg' : 'hover:bg-teal-50 text-slate-600'}`}
            >
              <div className="flex items-center gap-3 overflow-hidden">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center font-black flex-shrink-0 ${activeRoomId === room.id ? 'bg-white/20 text-white' : 'bg-teal-100 text-teal-600'}`}>{room.name[0]}</div>
                <div className="overflow-hidden text-left">
                  <p className="text-sm font-bold truncate">{room.name}</p>
                  <p className={`text-[9px] font-mono opacity-60 ${activeRoomId === room.id ? 'text-white' : 'text-slate-400'}`}>CODE: {room.code}</p>
                </div>
              </div>
              {room.createdBy === currentUser.id && (
                <button onClick={(e) => deleteRoom(room.id, e)} className={`p-1 transition-opacity duration-200 ${activeRoomId === room.id ? 'text-white/60 hover:text-white' : 'opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500'}`}>
                  <i className="fa-solid fa-trash-can text-xs"></i>
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="p-4 bg-slate-50 border-t flex items-center gap-3">
          <img src={currentUser.photoURL} className="w-10 h-10 rounded-full border-2 border-white shadow-sm" alt="User"/>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-black text-slate-700 truncate">{currentUser.name}</p>
            <button onClick={() => signOut(auth)} className="text-[9px] font-bold text-red-500 hover:underline">ログアウト</button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col bg-white relative">
        <header className="h-16 lg:h-20 border-b flex items-center justify-between px-4 lg:px-8 bg-white/90 backdrop-blur-md sticky top-0 z-30 shadow-sm">
          <div className="flex items-center gap-4 overflow-hidden">
            <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden w-10 h-10 flex items-center justify-center text-slate-500 bg-slate-100 rounded-xl active:bg-slate-200"><i className="fa-solid fa-bars-staggered text-xl"></i></button>
            <div className="overflow-hidden">
              <h2 className="font-black text-lg text-slate-800 truncate leading-none mb-1">{activeRoom?.name || 'ルーム未選択'}</h2>
              {activeRoom && <p className="text-[10px] text-teal-600 font-bold font-mono">CODE: {activeRoom.code}</p>}
            </div>
          </div>
          <button 
            onClick={async () => {
              setIsSummarizing(true);
              const res = await summarizeChat(messages);
              setSummary(res);
              setIsSummarizing(false);
            }}
            disabled={isSummarizing || messages.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-teal-500 to-emerald-600 text-white rounded-2xl text-[12px] sm:text-sm font-black shadow-lg shadow-teal-100 hover:shadow-teal-200 active:scale-95 disabled:opacity-50 transition-all"
          >
            {isSummarizing ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-wand-magic-sparkles"></i>}
            <span>AI要約</span>
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-6 bg-slate-50/50 scroll-smooth">
          {rooms.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center p-8">
              <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center mb-6 animate-bounce">
                <i className="fa-solid fa-door-open text-5xl opacity-20"></i>
              </div>
              <h3 className="font-black text-lg text-slate-600 mb-2">まだルームに参加していません</h3>
              <p className="text-sm mb-8 leading-relaxed">右下のボタン、または左上のメニューから<br/>ルームの作成か参加（コード入力）を行ってください。</p>
              <div className="flex gap-4">
                <button onClick={() => setShowCreateModal(true)} className="px-6 py-3 bg-teal-600 text-white rounded-2xl font-black shadow-lg shadow-teal-100">新しく作る</button>
                <button onClick={() => setShowJoinModal(true)} className="px-6 py-3 bg-slate-100 text-slate-600 rounded-2xl font-black">コードで参加</button>
              </div>
            </div>
          ) : !activeRoomId ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300 italic"><i className="fa-solid fa-arrow-left text-5xl mb-4 opacity-10"></i><p>左のメニューからルームを選択してください</p></div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-300">
               <i className="fa-solid fa-comment-dots text-5xl mb-4 opacity-10"></i>
               <p className="text-sm font-bold">メッセージがありません。会話を始めましょう！</p>
            </div>
          ) : (
            messages.map((msg, i) => {
              const isMe = msg.senderId === currentUser.id;
              return (
                <div key={msg.id} className={`flex gap-3 ${isMe ? 'flex-row-reverse' : ''} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                  <img src={msg.senderPhoto} className="w-8 h-8 rounded-full border-2 border-white shadow-sm self-end mb-1" />
                  <div className={`max-w-[85%] sm:max-w-[70%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                    <span className="text-[9px] font-black text-slate-400 mb-1 px-1">{msg.senderName}</span>
                    <div className={`p-4 rounded-[1.5rem] text-[13px] sm:text-sm shadow-sm relative leading-relaxed ${msg.isImportant ? 'bg-amber-50 border-2 border-amber-200 ring-4 ring-amber-100/30' : isMe ? 'bg-teal-600 text-white rounded-tr-none' : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'}`}>
                      {msg.isImportant && <span className="absolute -top-2 -left-2 bg-amber-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-[10px] shadow-md border-2 border-white font-black">!</span>}
                      {msg.imageUrl && <img src={msg.imageUrl} className="rounded-xl mb-3 max-w-full border border-slate-200" onClick={() => window.open(msg.imageUrl)}/>}
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                      <div className={`text-[8px] mt-2 font-bold ${isMe ? 'text-teal-200 text-right' : 'text-slate-400'}`}>{new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <footer className="p-4 sm:p-6 bg-white border-t border-slate-100">
          <form onSubmit={handleSendMessage} className="max-w-4xl mx-auto flex items-end gap-3">
            <button type="button" onClick={() => fileInputRef.current?.click()} className="w-12 h-12 flex items-center justify-center bg-slate-50 text-slate-400 rounded-2xl hover:bg-slate-100 transition-all border border-slate-100 shadow-sm"><i className="fa-solid fa-camera text-xl"></i></button>
            <input type="file" ref={fileInputRef} onChange={async (e) => {
              const file = e.target.files?.[0];
              if(file) handleSendMessage(undefined, await processImage(file));
            }} className="hidden" accept="image/*" />
            
            <div className="flex-1 bg-slate-50 rounded-[1.5rem] p-2 border border-slate-200 focus-within:border-teal-400 focus-within:ring-4 focus-within:ring-teal-100 transition-all shadow-inner">
              <textarea
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                placeholder="メッセージを入力..."
                rows={1}
                className="bg-transparent w-full px-3 py-2 outline-none text-[13px] sm:text-sm resize-none max-h-32"
                onKeyDown={e => { if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }}}
              />
              <div className="flex justify-between items-center px-2 pb-1">
                <button type="button" onClick={() => setIsImportant(!isImportant)} className={`text-[10px] px-3 py-1 rounded-full border-2 font-black transition-all ${isImportant ? 'bg-amber-400 text-white border-amber-500 shadow-sm' : 'text-slate-400 bg-white border-slate-200'}`}>重要マーク</button>
              </div>
            </div>
            
            <button type="submit" disabled={!inputText.trim() && !activeRoomId} className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-lg ${inputText.trim() ? 'bg-teal-600 text-white active:scale-90 shadow-teal-100' : 'bg-slate-100 text-slate-300 shadow-none'}`}><i className="fa-solid fa-paper-plane text-xl"></i></button>
          </form>
        </footer>
      </main>

      {/* Create Room Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
            <h3 className="font-black text-xl mb-4 text-slate-800">新しいルームを作成</h3>
            <p className="text-xs text-slate-500 mb-6 italic leading-relaxed">作成したルームには招待コードが発行されます。<br/>他のスタッフに参加してもらう際に共有してください。</p>
            <input value={newRoomName} onChange={e => setNewRoomName(e.target.value)} placeholder="例：受付連絡、オペ室" className="w-full p-4 bg-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-teal-100 mb-6 font-bold" autoFocus />
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)} className="flex-1 py-4 font-black text-slate-400">閉じる</button>
              <button onClick={createRoom} className="flex-1 py-4 bg-teal-600 text-white rounded-2xl font-black shadow-lg">作成する</button>
            </div>
          </div>
        </div>
      )}

      {/* Join Room Modal */}
      {showJoinModal && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[100] flex items-center justify-center p-6">
          <div className="bg-white rounded-[2.5rem] p-8 w-full max-w-sm shadow-2xl animate-in zoom-in duration-300">
            <h3 className="font-black text-xl mb-2 text-slate-800">ルームに参加</h3>
            <p className="text-xs text-slate-500 mb-6 leading-relaxed">共有された6桁のコードを入力してください。<br/>一度参加すると一覧に保存されます。</p>
            <input value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} maxLength={6} placeholder="ABCDEF" className="w-full p-5 bg-slate-100 rounded-2xl outline-none focus:ring-4 focus:ring-blue-100 mb-6 text-center font-mono text-3xl tracking-[0.4em] font-black" />
            <div className="flex gap-3">
              <button onClick={() => setShowJoinModal(false)} className="flex-1 py-4 font-black text-slate-400">閉じる</button>
              <button onClick={joinRoomByCode} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black shadow-lg">参加する</button>
            </div>
          </div>
        </div>
      )}

      {/* Summary Modal */}
      {summary && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg shadow-2xl overflow-hidden animate-in zoom-in duration-300">
            <div className="p-8 bg-teal-600 text-white flex justify-between items-center relative shadow-lg">
              <h3 className="font-black text-lg leading-tight"><i className="fa-solid fa-sparkles mr-2 animate-pulse"></i>AI 業務要約</h3>
              <button onClick={() => setSummary(null)} className="w-10 h-10 flex items-center justify-center bg-white/10 rounded-full hover:bg-white/20 transition-all"><i className="fa-solid fa-xmark"></i></button>
            </div>
            <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto bg-white">
              <div className="bg-teal-50 p-6 rounded-[2rem] text-sm text-slate-700 italic border-l-4 border-teal-400 shadow-inner leading-relaxed">
                {summary.summary}
              </div>
              <div>
                <h4 className="text-[10px] font-black text-amber-600 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <span className="w-3 h-3 bg-amber-400 rounded-full"></span>重要ポイント
                </h4>
                <ul className="space-y-2">
                  {summary.keyPoints.map((p,i)=><li key={i} className="text-xs flex gap-2 font-bold text-slate-600"><i className="fa-solid fa-circle-check text-amber-500 mt-0.5"></i>{p}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="text-[10px] font-black text-blue-600 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <span className="w-3 h-3 bg-blue-400 rounded-full"></span>次のアクション
                </h4>
                <ul className="space-y-2">
                  {summary.actionItems.map((a,i)=><li key={i} className="text-xs flex gap-2 font-bold text-slate-600"><i className="fa-solid fa-arrow-right text-blue-500 mt-0.5"></i>{a}</li>)}
                </ul>
              </div>
            </div>
            <div className="p-8 bg-slate-50 text-center border-t border-slate-100">
              <button onClick={()=>setSummary(null)} className="px-16 py-4 bg-white border-2 border-slate-200 rounded-2xl font-black text-slate-500 hover:text-teal-600 hover:border-teal-400 transition-all shadow-sm active:scale-95">内容を確認しました</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
