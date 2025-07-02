// ======= 1) Firebase 設定  =======
const firebaseConfig = {
    apiKey: "AIzaSyB-H74YVpBA8BPMFtWMOJvMRRkHyMoTT6k",
    authDomain: "team-draft-app.firebaseapp.com",
    databaseURL: "https://team-draft-app-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "team-draft-app",
    storageBucket: "team-draft-app.firebasestorage.app",
    messagingSenderId: "865072849567",
    appId: "1:865072849567:web:878f3c25f867900914b8aa",
    measurementId: "G-TE7255NTDR"
};

// ======= 2) 変数初期化 =======
let app, db, currentRoom = null;
const userId = `user_${Math.random().toString(36).slice(2,9)}`;
let userName = localStorage.getItem('draftUserName') || userId;
let isAdmin = false;
let connectedUsers = {};
let roomListListener = null;
let draggedMember = null;
let draggedFrom = null;
let stateHistory = [];
let historyIndex = -1;

        /**
 * 現在の gameState を履歴にプッシュ
 */
function pushHistory() {
  // 最新状態以降の履歴を切り捨て
  stateHistory = stateHistory.slice(0, historyIndex + 1);
  // 深いコピーで保存
  stateHistory.push(JSON.parse(JSON.stringify(gameState)));
  historyIndex = stateHistory.length - 1;
  updateNavButtons();
}

/**
 * 戻る（undo）
 */
function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    gameState = JSON.parse(JSON.stringify(stateHistory[historyIndex]));
    syncGameState();
    updateDisplay();
  }
}

/**
 * 進む（redo）
 */
function redo() {
  if (historyIndex < stateHistory.length - 1) {
    historyIndex++;
    gameState = JSON.parse(JSON.stringify(stateHistory[historyIndex]));
    syncGameState();
    updateDisplay();
  }
}

/**
 * ボタンの有効・無効を切り替え
 */
function updateNavButtons() {
  qs('#undoBtn').disabled = !(isAdmin && historyIndex > 0);
  qs('#redoBtn').disabled = !(isAdmin && historyIndex < stateHistory.length - 1);
}

// デフォルト状態を返す関数
const initialGameState = () => ({
    members: [],               // {name, available}
    teams: { A: [], B: [], C: [] },
    gameStarted: false,
    isSelectingLeaders: true,
    leaderSelected: { A:false, B:false, C:false },
    currentTeam: 'A',
    currentRound: 1,           // 現在の巡目（代表者選択が1巡目）
    pickHistory: []            // ピック履歴 [{round: 1, team: 'A', member: '山田'}]
});

// gameStateを初期化
let gameState = initialGameState();

// ======= 3) Firebase 初期化 =======
const initFirebase = () => {
    try {
        app = firebase.initializeApp(firebaseConfig);
        db  = firebase.database();

        // 接続状況監視
        db.ref('.info/connected').on('value', snap => {
            const connected = snap.val() === true;
            updateConnectionStatus(connected ? 'connected' : 'disconnected', 
                connected ? '🟢 システム に接続しました' : '🔴 システム との接続が切断されました');
            
            // 接続成功時にルーム監視を開始
            if(connected) {
                setTimeout(() => watchActiveRooms(), 1000); // 少し遅延させて確実に接続
            }
        });
        
        return true;
    } catch (e) {
        console.error('Firebase初期化エラー:', e);
        updateConnectionStatus('disconnected', 'Firebase 初期化失敗');
        return false;
    }
};

// ======= 4) UI ヘルパ =======
const qs = s => document.querySelector(s);
const updateConnectionStatus = (cls,msg)=>{
    const el = qs('#connectionStatus');
    el.className = `connection-status ${cls}`;
    el.textContent = msg;
};
const enableUI = () => {
    if(isAdmin) {
        qs('#memberName').disabled = false;
        qs('#addMemberBtn').disabled = false;
        qs('.reset-btn').disabled = false;
    }
};

// ======= 5) ルーム参加／作成 =======
const createRandomRoom = () => {
    const rnd = `room_${Math.random().toString(36).slice(2,8)}`;
    qs('#roomInput').value = rnd;
    joinRoom();
};

const joinRoom = () => {
    if(!db){alert('Firebase 未接続');return;}
    const room = qs('#roomInput').value.trim();
    if(!room){alert('ルーム名を入力してください');return;}

    // 既に同じルームにいる場合は何もしない
    if(currentRoom === room) {
        alert('既にこのルームに参加しています');
        return;
    }

    // 旧リスナ解除
    if(currentRoom) {
        leaveRoom(false); // アラートなしで退室
    }
    
    currentRoom = room;
    updateConnectionStatus('connecting','🟡 ルームに接続中…');

    // gameState 監視
    const gameStateRef = db.ref(`rooms/${room}/gameState`);
    gameStateRef.on('value', snap=>{
        if(snap.exists()){
            gameState = snap.val();
            // データの整合性チェック
            if(!gameState.members) gameState.members = [];
            if(!gameState.teams) gameState.teams = { A: [], B: [], C: [] };
            // 各チームが配列であることを確認
            ['A', 'B', 'C'].forEach(team => {
                if(!Array.isArray(gameState.teams[team])) {
                    gameState.teams[team] = [];
                }
            });
            // 新しいプロパティの初期化
            if(!gameState.currentRound) gameState.currentRound = 0;
            if(!gameState.pickHistory) gameState.pickHistory = [];
        }else{
            // 新規ルームの場合は初期状態を設定
            gameState = initialGameState();
            db.ref(`rooms/${room}/gameState`).set(gameState);
        }
        updateDisplay();
    });

    // ルームが削除された場合の処理
    db.ref(`rooms/${room}`).on('value', snap => {
        if(!snap.exists() && currentRoom === room) {
            alert('ルームが削除されました');
            leaveRoom(false);
        }
    });

    // オンラインユーザー監視
    db.ref(`rooms/${room}/users`).on('value', snap=>{
        connectedUsers = snap.val()||{};
        updateOnlineUsers();
    });

    // 自分を登録 & 切断時削除
    const userRef = db.ref(`rooms/${room}/users/${userId}`);
    userRef.set({
        name: userName,
        isAdmin: isAdmin,
        joinedAt: firebase.database.ServerValue.TIMESTAMP
    });
    userRef.onDisconnect().remove();

    enableUI();
    qs('#turnIndicator').style.display = 'block';
    updateConnectionStatus('connected',`🟢 ルーム "${room}" に参加中`);
    updateDisplay();
};

// ルーム退室
const leaveRoom = (showAlert = true) => {
    if (!currentRoom) return;

    const leavingRoom = currentRoom; // 退室するルーム名を保存

    // リスナー解除
    db.ref(`rooms/${currentRoom}`).off();

    // ユーザー削除
    db.ref(`rooms/${currentRoom}/users/${userId}`).remove();

    // UI リセット
    currentRoom = null;  // 現在のルームをクリア
    gameState = initialGameState();
    connectedUsers = {};

    // UI 無効化
    qs('#memberName').disabled = true;
    qs('#addMemberBtn').disabled = true;
    qs('.reset-btn').disabled = true;
    qs('#turnIndicator').style.display = 'none';
    qs('#roomInput').value = '';

    updateDisplay();
    updateOnlineUsers();
    updateConnectionStatus('connected', '🟢 システム に接続しました（ルーム未参加）');

    // ルーム一覧を強制的に更新（退室したルームの緑色を解除）
    db.ref('rooms').once('value', snap => {
        const rooms = snap.val() || {};
        updateRoomList(rooms);
    });

    if (showAlert) {
        alert('ルームから退室しました');
    }

    // 退室後に該当ルームのユーザー数をチェック（ゲーム開始済みは削除しない）
    setTimeout(() => {
        db.ref(`rooms/${leavingRoom}`).once('value', snap => {
            const roomData = snap.val();
            if (roomData) {
                const hasUsers     = roomData.users && Object.keys(roomData.users).length > 0;
                const gameStarted  = roomData.gameState && roomData.gameState.gameStarted === true;
                const hasMembers   = roomData.gameState && roomData.gameState.members && roomData.gameState.members.length > 0;

                // ユーザーが0人で、かつゲームが開始されていない、かつメンバー登録もないルームのみ削除
                if (!hasUsers && !gameStarted && !hasMembers) {
                    console.log(`ルーム ${leavingRoom} が空になり、ゲーム未開始、メンバーなしのため削除します`);
                    db.ref(`rooms/${leavingRoom}`).remove();
                } else if (!hasUsers) {
                    console.log(`ルーム ${leavingRoom} は空ですが、以下の理由で保持します:`);
                    console.log(`- ゲーム開始: ${gameStarted}`);
                    console.log(`- メンバー数: ${hasMembers ? roomData.gameState.members.length : 0}`);
                }
            }
        });
    }, 500);
};

// ユーザー名更新
const updateUserName = () => {
    if(isAdmin) {
        alert('管理者名は変更できません');
        return;
    }
    
    const newName = qs('#userNameInput').value.trim();
    if(!newName) {
        alert('ユーザー名を入力してください');
        return;
    }
    
    userName = newName;
    localStorage.setItem('draftUserName', userName);
    qs('#currentUserName').textContent = userName;
    qs('#userNameInput').value = '';
    
    // 現在ルームに参加中なら更新
    if(currentRoom && db) {
        db.ref(`rooms/${currentRoom}/users/${userId}/name`).set(userName);
    }
    
    alert('ユーザー名を変更しました');
};

// 管理者ログイン
const showAdminLogin = () => {
    qs('#adminDialog').style.display = 'block';
    qs('#adminId').value = '';
    qs('#adminPassword').value = '';
    qs('#adminId').focus();
};

const closeAdminLogin = () => {
    qs('#adminDialog').style.display = 'none';
};


// 管理者画面を表示するユーティリティ
function showAdminUI() {
  // ① ルームに参加中なら退出
  if (currentRoom) leaveRoom(false);

  isAdmin = true;
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
  const btn = qs('#adminLoginBtn');
  btn.textContent = '🔓 管理者ログアウト';
  btn.onclick = doAdminLogout;
}

// 既存の doAdminLogin() はこのままでOK
function doAdminLogin() {
  const pw = document.getElementById('adminPassword').value;
  if (!pw) { alert('パスワードを入力してください'); return; }
  db.ref('adminPassword').once('value')
    .then(snapshot => {
      const savedPw = snapshot.val();
      if (pw === savedPw) {
        closeAdminLogin();
        showAdminUI();    // ここで先ほど定義した関数を呼び出す
      } else {
        alert('パスワードが違います');
      }
    })
    .catch(err => {
      console.error('DB 読み込みエラー:', err);
      alert('ログイン処理中にエラーが発生しました');
    });
}

// 管理者画面を隠すユーティリティ
function doAdminLogout() {
  if (!confirm('管理者からログアウトしますか？')) return;

  // ② ルームに参加中なら退出
  if (currentRoom) leaveRoom(false);

  isAdmin = false;
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
  const btn = qs('#adminLoginBtn');
  btn.textContent = '🔐 管理者ログイン';
  btn.onclick = showAdminLogin;
  alert('管理者からログアウトしました');
}

// 管理者ログインボタンの動的切り替え
qs('#adminLoginBtn').addEventListener('click', () => {

});

// アクティブルーム監視
const watchActiveRooms = () => {
    if(!db) {
        console.log('DB未接続のためルーム監視をスキップ');
        return;
    }
    
    console.log('ルーム監視を開始');
    
    // 既存のリスナーがあれば解除
    if(roomListListener) {
        db.ref('rooms').off('value', roomListListener);
    }
    
    roomListListener = db.ref('rooms').on('value', snap => {
        const rooms = snap.val() || {};
        console.log('ルーム一覧取得:', rooms);
        updateRoomList(rooms);
        
        // 0人のルームを自動削除（ゲーム開始済みのルームは除外）
        Object.keys(rooms).forEach(roomName => {
            const room = rooms[roomName];
            const hasUsers = room.users && Object.keys(room.users).length > 0;
            const gameStarted = room.gameState && room.gameState.gameStarted === true;
            const hasMembers = room.gameState && room.gameState.members && room.gameState.members.length > 0;
            
            // ユーザーが0人で、かつゲームが開始されていない、かつメンバー登録もないルームのみ削除
            if(!hasUsers && !gameStarted && !hasMembers) {
                console.log(`空のルーム ${roomName} を削除対象として検出`);
                console.log(`- ユーザー数: ${hasUsers ? Object.keys(room.users).length : 0}`);
                console.log(`- ゲーム開始: ${gameStarted}`);
                console.log(`- メンバー数: ${hasMembers ? room.gameState.members.length : 0}`);
                
                // 1秒後に再確認して削除
                setTimeout(() => {
                    db.ref(`rooms/${roomName}`).once('value', roomSnap => {
                        const roomData = roomSnap.val();
                        if(roomData) {
                            const stillNoUsers = !roomData.users || Object.keys(roomData.users).length === 0;
                            const stillNotStarted = !roomData.gameState || roomData.gameState.gameStarted !== true;
                            const stillNoMembers = !roomData.gameState || !roomData.gameState.members || roomData.gameState.members.length === 0;
                            
                            if(stillNoUsers && stillNotStarted && stillNoMembers) {
                                db.ref(`rooms/${roomName}`).remove()
                                    .then(() => console.log(`ルーム ${roomName} を削除しました`))
                                    .catch(err => console.error(`ルーム削除エラー:`, err));
                            } else {
                                console.log(`ルーム ${roomName} は削除条件を満たさないため保持`);
                            }
                        }
                    });
                }, 1000);
            }
        });
    }, error => {
        console.error('ルーム一覧取得エラー:', error);
        qs('#roomList').innerHTML = '<div class="empty-state">ルーム一覧の取得に失敗しました</div>';
    });
};

// ルーム一覧更新
const updateRoomList = (rooms) => {
  const container = qs('#roomList');
  const roomNames = Object.keys(rooms);
  if (roomNames.length === 0) {
    container.innerHTML = '<div class="empty-state">アクティブなルームがありません</div>';
    return;
  }
  container.innerHTML = roomNames.map(roomName => {
    const room = rooms[roomName];
    const userCount = room.users ? Object.keys(room.users).length : 0;
    const memberCount = room.gameState?.members?.length || 0;
    const gameStarted = room.gameState?.gameStarted;
    const isCurrent = roomName === currentRoom;

    // ボタンHTML
    let btns = '';
    if (isCurrent) {
      // ログアウトではなく「退室」ボタンを全員に表示
      btns += `<button class="leave-btn" onclick="event.stopPropagation(); leaveRoom()">退室</button>`;
    }

    return `
      <div class="room-item ${isCurrent?'current':''}" 
           onclick="${isCurrent?'':'selectRoom(\''+roomName+'\')'}" 
           style="position:relative">
        <strong>${roomName}</strong>
        <div style="font-size:.7rem;margin-top:2px">
          👥 ${userCount}人 | 📋 ${memberCount}名登録 ${gameStarted?'| 🎮 ゲーム中':''} ${isCurrent?'(参加中)':''}
        </div>
        ${btns}
      </div>
    `;
  }).join('');
};

// ルーム削除
const deleteRoom = (roomName) => {
    if(!isAdmin) {
        alert('管理者のみがルームを削除できます');
        return;
    }
    
    if(!confirm(`ルーム「${roomName}」を削除しますか？\n参加中のメンバーは全員退出されます。`)) return;
    
    // 自分が参加中のルームの場合は先に退出
    if(currentRoom === roomName) {
        leaveRoom(false);
    }
    
    // Firebaseからルームを削除
    if(db) {
        db.ref(`rooms/${roomName}`).remove()
            .then(() => {
                alert(`ルーム「${roomName}」を削除しました`);
            })
            .catch(error => {
                console.error('ルーム削除エラー:', error);
                alert('ルームの削除に失敗しました');
            });
    }
};

// ======= 6) オンラインユーザー表示 =======
const updateOnlineUsers = () => {
    const container = qs('#onlineUsers');
    const list = qs('#userList');
    const users = Object.entries(connectedUsers);
    qs('#userCount').textContent = users.length;
    if(users.length > 0){
        container.style.display='block';
        list.innerHTML = users.map(([uid, data]) => {
          const displayName = data.name || uid;
          const isMe = uid === userId;
          // バッジ本体
          const badge = `<span class="user-badge" style="${isMe?'background:#28a745':''}">
                           ${displayName}${isMe?' (自分)':''}
                         </span>`;
          // 管理者かつ自分以外なら “×” ボタンを追加
          if(isAdmin && !isMe) {
            return `<div style="display:inline-block;position:relative">
                      ${badge}
                      <button class="kick-btn" onclick="kickUser('${uid}','${displayName}')" 
                              title="退室させる">×</button>
                    </div>`;
          }
          return badge;
        }).join('');
    }else{
        container.style.display='none';
    }
};

// ======= 7) メンバー追加 =======
const addMember = () => {
    if(!isAdmin){alert('管理者のみがメンバーを追加できます');return;}
    if(!currentRoom){alert('ルームに参加してください');return;}
    const name = qs('#memberName').value.trim();
    if(!name){alert('メンバー名を入力してください');return;}
    
    // gameState.membersが配列であることを確認
    if(!Array.isArray(gameState.members)){
        gameState.members = [];
    }
    
    if(gameState.members.some(m=>m.name===name)){
        alert('同名のメンバーがいます');
        return;
    }
    
    gameState.members.push({name, available:true});
    qs('#memberName').value='';
    syncGameState();
};

// ======= 8) ドラフトロジック =======
const canSelectMember = () => {
    if(!gameState.gameStarted) return false;
    if(gameState.isSelectingLeaders) return !gameState.leaderSelected[gameState.currentTeam];
    return gameState.members && gameState.members.some(m=>m.available);
};

const selectMember = (memberName) => {
    if (!canSelectMember()) { alert('現在選択権がありません'); return; }
    if (!confirm(`${memberName}さんを選択しますか？`)) return;

    // --- 配属処理（既存） ---
    const idx = gameState.members.findIndex(m => m.name === memberName);
    gameState.members[idx].available = false;
    gameState.teams[gameState.currentTeam].push(memberName);

    // --- 代表者選択ステージ（round 0） ---
    if (gameState.isSelectingLeaders) {
        gameState.pickHistory.push({ round: 0, team: gameState.currentTeam, member: memberName });
        gameState.leaderSelected[gameState.currentTeam] = true;

        // 次の代表者チーム
        const teams     = ['A','B','C'];
        const nextLeader = teams.find(t => !gameState.leaderSelected[t]);
        if (nextLeader) {
            gameState.currentTeam = nextLeader;
        } else {
            // 代表者選択完了 → 第1巡目スタート（rep picks の順番そのまま）
            gameState.isSelectingLeaders = false;
            gameState.currentRound       = 1;
            const repOrder = getLastRoundPicks(0).map(p => p.team);  // e.g. ['A','B','C']
            gameState.currentTeam = repOrder[0];                    // → 'A'
        }

    // --- 通常ピックステージ（round ≥1） ---
    } else {
        gameState.pickHistory.push({
            round:  gameState.currentRound,
            team:   gameState.currentTeam,
            member: memberName
        });
        const picksThisRound = getLastRoundPicks(gameState.currentRound);
        const numTeams       = 3;

        if (gameState.currentRound === 1) {
            // 第1巡目は repOrder の順
            const repOrder = getLastRoundPicks(0).map(p => p.team);
            if (picksThisRound.length < numTeams) {
                // まだ repOrder[picksThisRound.length] が残っている
                gameState.currentTeam = repOrder[picksThisRound.length];
            } else {
                // 第1巡目完了 → 第2巡目は「第1巡目 picks の逆順」
                gameState.currentRound++;
                gameState.currentTeam = repOrder.slice().reverse()[0];
            }
        } else {
            // 第2巡目以降は「前巡の逆順」で回す
            if (picksThisRound.length === numTeams) {
                // 巡が終了 → 次の巡へ
                const reversed = picksThisRound.slice().reverse();
                gameState.currentRound++;
                gameState.currentTeam = reversed[0].team;
            } else {
                // 前巡逆順で、まだ選んでいないチームを選出
                const lastRound    = gameState.currentRound - 1;
                const lastPicks    = getLastRoundPicks(lastRound);
                const reversedLast = lastPicks.slice().reverse().map(p => p.team);
                const pickedTeams  = picksThisRound.map(p => p.team);
                gameState.currentTeam = reversedLast.find(t => !pickedTeams.includes(t));
            }
        }
    }

    syncGameState();
    pushHistory();
    checkGameEnd();
};

const checkGameEnd = () => {
    // ゲーム完了の通知を削除（メンバー追加の可能性があるため）
};

// ======= 9) ゲーム開始／リセット =======
const startGame = () => {
    if(!isAdmin){alert('管理者のみがゲームを開始できます');return;}
    if(gameState.gameStarted) return;
    if(!gameState.members || gameState.members.length < 3){
        alert('最低3名のメンバーが必要です');
        return;
    }
    
    // メンバーを保持しながら他の状態をリセット
    gameState.gameStarted = true;
    gameState.isSelectingLeaders = true;
    gameState.leaderSelected = { A:false, B:false, C:false };
    gameState.currentTeam = 'A';
    gameState.currentRound = 0;
    gameState.pickHistory = [];
    gameState.teams = { A: [], B: [], C: [] };
    // メンバーの available を全て true に
    gameState.members.forEach(m => m.available = true);
    
    syncGameState();
    pushHistory();
};

const resetGame = () => {
    if(!isAdmin){alert('管理者のみがリセットできます');return;}
    if(!confirm('チームメンバーを控えに戻しますか？')) return;
    
    // 各チームのメンバーを控えに戻す
    ['A', 'B', 'C'].forEach(team => {
        if(gameState.teams[team] && gameState.teams[team].length > 0) {
            gameState.teams[team].forEach(memberName => {
                const memberIndex = gameState.members.findIndex(m => m.name === memberName);
                if(memberIndex !== -1) {
                    gameState.members[memberIndex].available = true;
                }
            });
            gameState.teams[team] = [];
        }
    });
    
    // ゲーム状態をリセット
    gameState.gameStarted = false;
    gameState.isSelectingLeaders = true;
    gameState.leaderSelected = { A:false, B:false, C:false };
    gameState.currentTeam = 'A';
    gameState.currentRound = 0;
    gameState.pickHistory = [];
    
    syncGameState();
    pushHistory();
};

// =======10) Firebase 同期 =======
const syncGameState = () => {
    if(currentRoom && db) {
        db.ref(`rooms/${currentRoom}/gameState`).set(gameState);
    }
};

// =======11) 表示更新 =======
const updateDisplay = () => {
    updateAvailableMembers();
    updateTeamDisplay();
    updateTurnIndicator();
    updateTeamHighlight();
    updateStartButton();
    updateNavButtons();
};

const updateAvailableMembers = () => {
    const container = qs('#availableMembers');
    if(!currentRoom){
        container.innerHTML='<div class="empty-state">ルームに参加してください</div>';
        return;
    }
    
    const available = gameState.members ? gameState.members.filter(m=>m.available) : [];
    if(!available.length){
        container.innerHTML='<div class="empty-state">控えメンバーがいません</div>';
        return;
    }
    
    container.innerHTML = available.map(m=>`
        <div class="member-item ${canSelectMember()?'selectable':''}" 
             onclick="selectMember('${m.name}')"
             ${isAdmin ? `draggable="true"
             ondragstart="handleDragStart(event, '${m.name}', 'available')"
             ondragend="handleDragEnd(event)"
             ontouchstart="handleTouchStart(event, '${m.name}', 'available')"
             ontouchmove="handleTouchMove(event)"
             ontouchend="handleTouchEnd(event)"` : ''}>
            <span>${m.name}</span>
            ${isAdmin ? `<button class="delete-btn" onclick="event.stopPropagation(); deleteMember('${m.name}')" title="削除">×</button>` : ''}
            ${canSelectMember()?'<span style="font-size:.7rem;color:#28a745;margin-right:30px">選択</span>':''}
        </div>
    `).join('');
};

const updateTeamDisplay = () => {
    ['A','B','C'].forEach(t=>{
        const listEl = qs(`#team${t}Members`);
        const members = gameState.teams && gameState.teams[t] ? gameState.teams[t] : [];
        if(!members.length){
            listEl.innerHTML='<div class="empty-state">メンバーなし</div>';
            return;
        }
        listEl.innerHTML = members.map((name,i)=>`
            <div class="team-member" 
                 ${isAdmin ? `draggable="true"
                 ondragstart="handleDragStart(event, '${name}', '${t}')"
                 ondragend="handleDragEnd(event)"
                 ontouchstart="handleTouchStart(event, '${name}', '${t}')"
                 ontouchmove="handleTouchMove(event)"
                 ontouchend="handleTouchEnd(event)"` : ''}>
                ${i===0?'👑 ':''}${name}${i===0?' (代表)':''}
            </div>
        `).join('');
    });
};

// 指定した巡のピック履歴を返すヘルパー
const getLastRoundPicks = (round) => {
    return (gameState.pickHistory || [])
            .filter(p => p.round === round);
};

// ピック順序の更新
const updatePickOrder = () => {
    const currentRoundPicks = getLastRoundPicks(gameState.currentRound);
    const lastRoundPicks = getLastRoundPicks(gameState.currentRound - 1);
    
    // 現在の巡で全チームがピック済みか確認
    const pickedTeams = currentRoundPicks.map(p => p.team);
    const allTeamsPicked = ['A', 'B', 'C'].every(team => pickedTeams.includes(team));
    
    if(allTeamsPicked) {
        // 巡が終了したので次の巡へ
        gameState.currentRound++;
        // 次の巡は前巡の逆順
        const nextTeam = lastRoundPicks[0].team; // 前巡の最初のチーム
        gameState.currentTeam = nextTeam;
    } else {
        // まだ巡が続いている
        // 前巡の逆順で次のチームを決定
        let nextIndex = -1;
        for(let i = lastRoundPicks.length - 1; i >= 0; i--) {
            const team = lastRoundPicks[i].team;
            if(!pickedTeams.includes(team)) {
                gameState.currentTeam = team;
                break;
            }
        }
    }
};

// 現在のターンのメンバーを取得
const getCurrentTurnMember = () => {
    if(gameState.isSelectingLeaders) return null;
    
    const team = gameState.teams[gameState.currentTeam];
    const memberIndex = gameState.currentRound - 1;
    
    if(team && team[memberIndex]) {
        return team[memberIndex];
    }
    return null;
};

const updateTurnIndicator = () => {
    const txt = qs('#turnText');
    if(!currentRoom){
        txt.textContent='ルームに参加してください';
        return;
    }
    if(!gameState.gameStarted){
        txt.textContent='ゲーム開始を待っています';
        return;
    }
    
    if (gameState.isSelectingLeaders) {
        txt.textContent = `第${gameState.currentRound}巡目 - ${gameState.currentTeam}チーム：代表者を選択してください`;
    } else {
        const currentMember = getCurrentTurnMember();
        if(currentMember) {
            txt.textContent = `第${gameState.currentRound}巡目 - ${gameState.currentTeam}チーム：${currentMember}さんの番です`;
        } else {
            txt.textContent = `第${gameState.currentRound}巡目 - ${gameState.currentTeam}チーム：指名権を持っている人がいません`;
        }
    }
};

const updateTeamHighlight = () => {
    ['A','B','C'].forEach(t=>{
        const el = qs(`#team${t}`);
        if(gameState.gameStarted && t===gameState.currentTeam && canSelectMember()) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
};

const updateStartButton = () => {
    const btn = qs('#startGameBtn');
    if(!currentRoom){
        btn.disabled=true;
        btn.textContent='ルームに参加してください';
        return;
    }
    if(gameState.gameStarted){
        btn.disabled=true;
        btn.textContent='ゲーム進行中';
        return;
    }
    
    const memberCount = gameState.members ? gameState.members.length : 0;
    btn.disabled = memberCount < 3;
    btn.textContent = memberCount < 3 ? `ゲーム開始 (${memberCount}/3)` : 'ゲーム開始';
};

// ======= 12) ドラッグ&ドロップ機能（PC & モバイル対応） =======
let touchItem = null;
let touchTimeout = null;
let isDragging = false;

// PC用ドラッグ
const handleDragStart = (e, memberName, from) => {
    if(!isAdmin) return; // 管理者のみドラッグ可能
    
    if(e.type === 'dragstart') {
        draggedMember = memberName;
        draggedFrom = from;
        e.target.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    }
};

const handleDragEnd = (e) => {
    if(e.type === 'dragend') {
        e.target.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach(el => {
            el.classList.remove('drag-over');
        });
    }
};

const handleDragOver = (e) => {
    e.preventDefault();
    if(e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
    }
    const target = e.currentTarget;
    if(!target.classList.contains('drag-over')) {
        target.classList.add('drag-over');
    }
};

const handleDragLeave = (e) => {
    if(e.currentTarget === e.target) {
        e.currentTarget.classList.remove('drag-over');
    }
};

const handleDrop = (e, to) => {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    
    if(!draggedMember || !draggedFrom || draggedFrom === to) return;
    
    moveMember(draggedMember, draggedFrom, to);
    
    draggedMember = null;
    draggedFrom = null;
};

// モバイル用タッチ
const handleTouchStart = (e, memberName, from) => {
    if(!isAdmin) return; // 管理者のみドラッグ可能
    
    touchItem = e.target;
    touchTimeout = setTimeout(() => {
        isDragging = true;
        draggedMember = memberName;
        draggedFrom = from;
        touchItem.classList.add('dragging');
        touchItem.style.position = 'fixed';
        touchItem.style.zIndex = '9999';
        touchItem.style.pointerEvents = 'none';
        
        // 振動フィードバック（対応デバイスのみ）
        if(navigator.vibrate) navigator.vibrate(50);
    }, 500); // 500ms長押し
};

const handleTouchMove = (e) => {
    if(touchTimeout && !isDragging) {
        clearTimeout(touchTimeout);
        touchTimeout = null;
    }
    
    if(isDragging && touchItem) {
        e.preventDefault();
        const touch = e.touches[0];
        touchItem.style.left = (touch.clientX - touchItem.offsetWidth/2) + 'px';
        touchItem.style.top = (touch.clientY - touchItem.offsetHeight/2) + 'px';
        
        // ドロップ可能エリアの検出
        const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        
        if(dropTarget) {
            const droppable = dropTarget.closest('.team, .available-members');
            if(droppable) droppable.classList.add('drag-over');
        }
    }
};

const handleTouchEnd = (e) => {
    if(touchTimeout) {
        clearTimeout(touchTimeout);
        touchTimeout = null;
    }
    
    if(isDragging && touchItem) {
        const touch = e.changedTouches[0];
        const dropTarget = document.elementFromPoint(touch.clientX, touch.clientY);
        
        touchItem.classList.remove('dragging');
        touchItem.style.position = '';
        touchItem.style.zIndex = '';
        touchItem.style.pointerEvents = '';
        touchItem.style.left = '';
        touchItem.style.top = '';
        
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        
        if(dropTarget) {
            const teamA = dropTarget.closest('#teamA');
            const teamB = dropTarget.closest('#teamB');
            const teamC = dropTarget.closest('#teamC');
            const available = dropTarget.closest('.available-members');
            
            let to = null;
            if(teamA) to = 'A';
            else if(teamB) to = 'B';
            else if(teamC) to = 'C';
            else if(available) to = 'available';
            
            if(to && draggedMember && draggedFrom !== to) {
                moveMember(draggedMember, draggedFrom, to);
            }
        }
        
        isDragging = false;
        draggedMember = null;
        draggedFrom = null;
        touchItem = null;
    }
};

// メンバー移動の共通処理
const moveMember = (memberName, from, to) => {
    // 元の場所から削除
    let fromIndex = -1;
    if(from === 'available') {
        const idx = gameState.members.findIndex(m => m.name === memberName);
        if(idx !== -1) gameState.members[idx].available = false;
    } else {
        fromIndex = gameState.teams[from].indexOf(memberName);
        if(fromIndex !== -1) gameState.teams[from].splice(fromIndex, 1);
    }
    
    // 新しい場所に追加
    let toIndex = -1;
    if(to === 'available') {
        const idx = gameState.members.findIndex(m => m.name === memberName);
        if(idx !== -1) gameState.members[idx].available = true;
    } else {
        if(!gameState.teams[to]) gameState.teams[to] = [];
        gameState.teams[to].push(memberName);
        toIndex = gameState.teams[to].length - 1;
    }
    
    // ゲーム中の場合、ターン表示を更新
    if(gameState.gameStarted && !gameState.isSelectingLeaders) {
        // 移動によってターン表示が変わる可能性があるため再評価
        updateDisplay();
    }
    
    syncGameState();
};

// メンバー削除
const deleteMember = (memberName) => {
    if(!isAdmin) {
        alert('管理者のみがメンバーを削除できます');
        return;
    }
    
    if(!confirm(`${memberName}を削除しますか？`)) return;
    
    // membersから削除
    gameState.members = gameState.members.filter(m => m.name !== memberName);
    
    // 各チームからも削除
    ['A', 'B', 'C'].forEach(team => {
        if(gameState.teams[team]) {
            gameState.teams[team] = gameState.teams[team].filter(name => name !== memberName);
        }
    });
    
    syncGameState();
};

// ルーム選択
const selectRoom = (roomName) => {
    qs('#roomInput').value = roomName;
    joinRoom();
};

// ======= ユーザーを強制退室させる =======
const kickUser = (uid, name) => {
  if(!isAdmin) return;
  if(!confirm(`${name}さんをルームから退室させますか？`)) return;
  // Firebase 上のユーザー情報を削除
  db.ref(`rooms/${currentRoom}/users/${uid}`).remove()
    .then(() => {
      alert(`${name}さんを退室させました`);
    })
    .catch(err => {
      console.error('キック失敗:', err);
      alert('退室処理に失敗しました');
    });
};

// ======= 13) ページロード後 =======
window.addEventListener('load',()=>{
    initFirebase();
    
    // 初回ロード時は管理者UIを隠す
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    
    // ユーザー名を表示
    qs('#currentUserName').textContent = userName;
    qs('#userNameInput').value = userName;
    
    // Enterキーでのメンバー追加
    qs('#memberName').addEventListener('keypress', (e) => {
        if(e.key === 'Enter' && !e.target.disabled) {
            addMember();
        }
    });
    
    // Enterキーでのルーム参加
    qs('#roomInput').addEventListener('keypress', (e) => {
        if(e.key === 'Enter') {
            joinRoom();
        }
    });
    
    // Enterキーでのユーザー名変更
    qs('#userNameInput').addEventListener('keypress', (e) => {
        if(e.key === 'Enter') {
            updateUserName();
        }
    });
    // 初期 gameState を履歴に登録
    pushHistory();
});

// ページ離脱時のクリーンアップ
window.addEventListener('beforeunload', () => {
    if(currentRoom) {
        db.ref(`rooms/${currentRoom}/users/${userId}`).remove();
    }
});

// ファイル選択時に「一括追加」ボタンを有効化
qs('#bulkMemberFile').addEventListener('change', e => {
  const file = e.target.files[0];
  qs('#bulkAddBtn').disabled = !file;
});

// 一括登録関数
function bulkAddMembers() {
  if (!isAdmin) { alert('管理者のみ実行できます'); return; }
  const fileInput = qs('#bulkMemberFile');
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    // 改行で分割、空行は除去
    const names = reader.result.split(/\r?\n/).map(s => s.trim()).filter(s => s);
    let added = 0;
    names.forEach(name => {
      // 重複チェック
      if (!gameState.members.some(m => m.name === name)) {
        gameState.members.push({ name, available: true });
        added++;
      }
    });
    if (added) {
      syncGameState();
      alert(`${added} 名を一括追加しました`);
    } else {
      alert('追加可能な名前がありませんでした（重複または空行）');
    }
    // リセット
    fileInput.value = '';
    qs('#bulkAddBtn').disabled = true;
  };
  reader.readAsText(file, 'UTF-8');
}
