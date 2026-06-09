const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== PATHS ==========
const USERS_FILE = path.join(__dirname, 'users.json');
const INVITATIONS_FILE = path.join(__dirname, 'invitations.json');
const LINKS_FILE = path.join(__dirname, 'links.json');
const SCHEDULED_FILE = path.join(__dirname, 'scheduled_tasks.json');

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

// ========== FILE HELPERS ==========
function loadJSON(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) {}
    return null;
}
function saveJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ========== USER STORE ==========
function loadUsers() { return loadJSON(USERS_FILE) || {}; }
function saveUsers(users) { saveJSON(USERS_FILE, users); }

// ========== INVITATIONS ==========
function loadInvitations() { return loadJSON(INVITATIONS_FILE) || []; }
function saveInvitations(inv) { saveJSON(INVITATIONS_FILE, inv); }

// ========== LINKS ==========
function loadLinks() { return loadJSON(LINKS_FILE) || {}; }
function saveLinks(links) { saveJSON(LINKS_FILE, links); }

// ========== PAIR DATA ==========
function loadPairData(pairId) {
    const file = path.join(__dirname, `data_pair_${pairId}.json`);
    return loadJSON(file);
}
function savePairData(pairId, data) {
    const file = path.join(__dirname, `data_pair_${pairId}.json`);
    saveJSON(file, data);
}

// ========== SOLO DATA ==========
function loadSoloData(username) {
    const file = path.join(__dirname, `data_solo_${username}.json`);
    return loadJSON(file);
}
function saveSoloData(username, data) {
    const file = path.join(__dirname, `data_solo_${username}.json`);
    saveJSON(file, data);
}

// ========== SCHEDULED TASKS HELPERS ==========
function loadScheduledTasks() {
    try {
        if (fs.existsSync(SCHEDULED_FILE)) {
            return JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf8'));
        }
    } catch (e) {}
    return {};
}
function saveScheduledTasks(data) {
    fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(data, null, 2));
}
function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
    const { firstName, lastName, username, password } = req.body;
    if (!firstName || !lastName || !username || !password)
        return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 4)
        return res.status(400).json({ error: 'Password too short (min 4 chars).' });

    const users = loadUsers();
    if (users[username])
        return res.status(400).json({ error: 'Username already taken.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    users[username] = { firstName, lastName, password: hashedPassword };
    saveUsers(users);

    req.session.user = { username, firstName, lastName };
    res.json({ success: true });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Username and password required.' });

    const users = loadUsers();
    const user = users[username];
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid username or password.' });

    req.session.user = { username, firstName: user.firstName, lastName: user.lastName };
    res.json({ success: true });
});

app.get('/api/check-session', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ========== PROTECTED PAGE ROUTES ==========
app.get('/', (req, res) => {
    req.session.user ? res.redirect('/home.html') : res.redirect('/login.html');
});
app.get('/home.html', (req, res, next) => {
    req.session.user ? next() : res.redirect('/login.html');
});
app.get('/tracker.html', (req, res, next) => {
    req.session.user ? next() : res.redirect('/login.html');
});
app.get('/add-task.html', (req, res, next) => {
    req.session.user ? next() : res.redirect('/login.html');
});

// ========== SEARCH USERS ==========
app.get('/api/search-users', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const query = (req.query.q || '').toLowerCase();
    const users = loadUsers();
    const currentUser = req.session.user.username;
    const results = Object.entries(users)
        .filter(([username]) => username !== currentUser && username.toLowerCase().includes(query))
        .map(([username, userData]) => ({
            username,
            firstName: userData.firstName,
            lastName: userData.lastName
        }));
    res.json({ users: results });
});

// ========== INVITATIONS ==========
app.post('/api/invite', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const { partnerUsername } = req.body;
    const currentUser = req.session.user.username;
    const users = loadUsers();
    if (!users[partnerUsername]) return res.status(404).json({ error: 'User not found.' });
    if (partnerUsername === currentUser) return res.status(400).json({ error: 'Cannot invite yourself.' });

    const links = loadLinks();
    if (links[currentUser] || links[partnerUsername])
        return res.status(400).json({ error: 'You or the partner already have a link.' });

    const invitations = loadInvitations();
    const alreadySent = invitations.find(inv =>
        inv.from === currentUser && inv.to === partnerUsername && inv.status === 'pending'
    );
    if (alreadySent) return res.status(400).json({ error: 'Invitation already sent.' });

    const newInv = {
        id: uuidv4(),
        from: currentUser,
        fromName: `${req.session.user.firstName} ${req.session.user.lastName}`,
        to: partnerUsername,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    invitations.push(newInv);
    saveInvitations(invitations);
    res.json({ success: true, message: 'Invitation sent!' });
});

app.get('/api/notifications', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const currentUser = req.session.user.username;
    const invitations = loadInvitations().filter(inv =>
        inv.to === currentUser && inv.status === 'pending'
    );
    res.json({ invitations });
});

app.post('/api/invite/respond', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const { invitationId, action } = req.body;
    const invitations = loadInvitations();
    const idx = invitations.findIndex(inv => inv.id === invitationId);
    if (idx === -1) return res.status(404).json({ error: 'Invitation not found.' });

    const inv = invitations[idx];
    if (inv.to !== req.session.user.username) return res.status(403).json({ error: 'Not for you.' });
    if (inv.status !== 'pending') return res.status(400).json({ error: 'Already handled.' });

    if (action === 'accept') {
        const links = loadLinks();
        links[inv.from] = inv.to;
        links[inv.to] = inv.from;
        saveLinks(links);

        inv.status = 'accepted';
        invitations[idx] = inv;
        invitations.push({
            id: uuidv4(),
            from: inv.to,
            fromName: `${req.session.user.firstName} ${req.session.user.lastName}`,
            to: inv.from,
            status: 'accepted_notify',
            createdAt: new Date().toISOString()
        });
        saveInvitations(invitations);
        res.json({ success: true, message: 'You are now linked! 🎉' });
    } else if (action === 'reject') {
        inv.status = 'rejected';
        invitations[idx] = inv;
        saveInvitations(invitations);
        res.json({ success: true, message: 'Invitation rejected.' });
    } else {
        res.status(400).json({ error: 'Invalid action.' });
    }
});

// ========== LINK STATUS ==========
app.get('/api/link-status', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const currentUser = req.session.user.username;
    const links = loadLinks();
    if (links[currentUser]) {
        const partnerUsername = links[currentUser];
        const users = loadUsers();
        const partner = users[partnerUsername];
        res.json({
            linked: true,
            partnerUsername,
            partnerFirstName: partner ? partner.firstName : partnerUsername
        });
    } else {
        res.json({ linked: false });
    }
});

// ========== SOLO DATA API ==========
app.get('/api/solo-data', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const username = req.session.user.username;
    let data = loadSoloData(username);
    if (!data) {
        data = {
            tasks: ['Morning workout', 'Check emails', 'Main priority', 'Review progress', 'Learn something new'],
            completions: {}
        };
    }
    res.json(data);
});

app.post('/api/solo-data', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const username = req.session.user.username;
    saveSoloData(username, req.body);
    res.json({ status: 'ok' });
});

// ========== PAIR DATA API ==========
app.get('/api/pair-data', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const currentUser = req.session.user.username;
    const links = loadLinks();
    if (!links[currentUser]) return res.status(400).json({ error: 'No partner linked.' });

    const partner = links[currentUser];
    const pairId = [currentUser, partner].sort().join('_');
    let data = loadPairData(pairId);
    if (!data) {
        data = {
            partner1: {
                name: currentUser,
                tasks: ['Morning workout', 'Check emails', 'Main priority', 'Review', 'Learn'],
                completions: {}
            },
            partner2: {
                name: partner,
                tasks: ['Morning routine', 'Review schedule', 'Focus work', 'Check-in', 'Personal dev'],
                completions: {}
            }
        };
    }
    if (data.partner1.name !== currentUser) {
        [data.partner1, data.partner2] = [data.partner2, data.partner1];
        data.partner1.name = currentUser;
        data.partner2.name = partner;
    }
    res.json(data);
});

app.post('/api/pair-data', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const currentUser = req.session.user.username;
    const links = loadLinks();
    if (!links[currentUser]) return res.status(400).json({ error: 'No partner linked.' });

    const partner = links[currentUser];
    const pairId = [currentUser, partner].sort().join('_');
    const data = req.body;
    if (data.partner1 && data.partner1.name !== currentUser) {
        return res.status(400).json({ error: 'Invalid data mapping.' });
    }
    savePairData(pairId, data);
    res.json({ status: 'ok' });
});

// ========== SCHEDULED TASKS ROUTES ==========

// GET - Your tasks for a date
app.get('/api/scheduled-tasks', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'Date parameter required' });

    const allTasks = loadScheduledTasks();
    const userTasks = allTasks[req.session.user.username] || [];
    const tasksForDate = userTasks
        .filter(t => t.date === date)
        .map(t => ({ 
            ...t, 
            completed: t.completed === true,  // ensure boolean
            taskName: t.taskName || 'Unnamed Task'  // ensure name exists
        }));
    res.json({ tasks: tasksForDate });
});

// GET - Partner's tasks for a date
app.get('/api/partner-scheduled-tasks', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'Date parameter required' });

    const currentUser = req.session.user.username;
    const links = loadLinks();
    if (!links[currentUser]) return res.status(400).json({ error: 'No partner linked.' });

    const partner = links[currentUser];
    const allTasks = loadScheduledTasks();
    const partnerTasks = allTasks[partner] || [];
    const tasksForDate = partnerTasks
        .filter(t => t.date === date)
        .map(t => ({ 
            ...t, 
            completed: t.completed === true,
            taskName: t.taskName || 'Unnamed Task'
        }));
    res.json({ tasks: tasksForDate });
});

// POST - Create new task
app.post('/api/scheduled-tasks', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const { date, taskName, startTime, endTime } = req.body;
    if (!date || !taskName || !startTime || !endTime) {
        return res.status(400).json({ error: 'Missing fields. All fields are required: date, taskName, startTime, endTime' });
    }

    const today = new Date().toISOString().split('T')[0];
    if (date < today) return res.status(400).json({ error: 'Cannot schedule tasks in the past.' });

    const allTasks = loadScheduledTasks();
    const username = req.session.user.username;
    if (!allTasks[username]) allTasks[username] = [];
    const userTasks = allTasks[username];

    // Overlap check
    const overlap = userTasks.some(task => {
        if (task.date !== date) return false;
        const existStart = timeToMinutes(task.startTime);
        const existEnd = timeToMinutes(task.endTime);
        const newStart = timeToMinutes(startTime);
        const newEnd = timeToMinutes(endTime);
        return (newStart < existEnd && newEnd > existStart);
    });
    if (overlap) {
        return res.status(400).json({ error: 'Time slot overlaps with an existing task.' });
    }

    const newTask = {
        id: uuidv4(),
        date: date,
        taskName: taskName.trim(),
        startTime: startTime,
        endTime: endTime,
        assignee: username,
        completed: false,
        createdAt: new Date().toISOString()
    };

    allTasks[username].push(newTask);
    saveScheduledTasks(allTasks);
    res.status(201).json({ success: true, task: newTask });
});

// PUT - Edit a task
app.put('/api/scheduled-tasks/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const taskId = req.params.id;
    const { taskName, startTime, endTime, date } = req.body;
    if (!taskName || !startTime || !endTime) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const allTasks = loadScheduledTasks();
    const username = req.session.user.username;
    if (!allTasks[username]) return res.status(404).json({ error: 'No tasks' });
    const task = allTasks[username].find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    // Check overlap excluding this task
    const otherTasks = allTasks[username].filter(t => t.id !== taskId && t.date === date);
    const newStart = timeToMinutes(startTime);
    const newEnd = timeToMinutes(endTime);
    const overlap = otherTasks.some(t => {
        const existStart = timeToMinutes(t.startTime);
        const existEnd = timeToMinutes(t.endTime);
        return (newStart < existEnd && newEnd > existStart);
    });
    if (overlap) return res.status(400).json({ error: 'Time slot overlaps.' });

    task.taskName = taskName.trim();
    task.startTime = startTime;
    task.endTime = endTime;
    saveScheduledTasks(allTasks);
    res.json({ success: true, task });
});

// PATCH - Mark task as complete
app.patch('/api/scheduled-tasks/:id/complete', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const taskId = req.params.id;
    const allTasks = loadScheduledTasks();
    const username = req.session.user.username;
    if (!allTasks[username]) return res.status(404).json({ error: 'No tasks found' });

    const task = allTasks[username].find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    if (task.completed) {
        return res.status(400).json({ error: 'Task already completed.' });
    }

    task.completed = true;
    saveScheduledTasks(allTasks);
    res.json({ success: true, task });
});

// DELETE - Remove a task
app.delete('/api/scheduled-tasks/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
    const taskId = req.params.id;
    const allTasks = loadScheduledTasks();
    const username = req.session.user.username;
    if (!allTasks[username]) return res.status(404).json({ error: 'No tasks found' });

    const index = allTasks[username].findIndex(t => t.id === taskId);
    if (index === -1) return res.status(404).json({ error: 'Task not found' });

    allTasks[username].splice(index, 1);
    saveScheduledTasks(allTasks);
    res.json({ success: true });
});

// ========== START ==========
app.listen(PORT, () => {
    console.log(`✅ Tracker running at http://localhost:${PORT}`);
});