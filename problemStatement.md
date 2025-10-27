# Claude Code Remote Controller (CCRC)

## 🎯 Project Overview

**Claude Code Remote Controller** is a full-stack remote management system that enables developers to control, monitor, and interact with Claude Code development sessions from anywhere - specifically designed for mobile-first workflows.

### Elevator Pitch

> "I'm working on complex development projects using Claude Code on my MacBook, but I'm not always at my desk. I want to start coding tasks, check progress, view live development servers, and interact with Claude Code from my iPhone while I'm on the couch, commuting, or traveling - all without being tethered to my computer."

---

## 🔥 The Problem

### Current Limitations

**1. Desktop Dependency**
- Claude Code runs in the terminal on a specific machine
- No way to interact with it remotely
- Can't check on long-running tasks when away from desk
- Miss notifications about completed work or errors

**2. Local Server Accessibility**
- Claude Code spins up dev servers on `localhost:3000`, `:8000`, etc.
- These are only accessible on the same machine
- Can't preview the app Claude built from another device
- Can't show stakeholders work-in-progress without screen sharing

**3. Context Switching Friction**
- Have to be physically at computer to send new commands
- Can't quickly check "did that build finish?"
- Can't respond to Claude's questions when mobile
- Lose productivity during dead time (commute, waiting, etc.)

**4. Session Management**
- Hard to track multiple concurrent Claude Code sessions
- No overview of what's running, what ports are active
- Manual tunnel creation is tedious
- No history or logs when you return to the session

**5. Collaboration Barriers**
- Can't easily share live preview with team members
- Can't hand off control to another developer
- No way to review what Claude did while you were away

---

## ✨ The Solution

A three-tier architecture that transforms Claude Code into a remotely accessible, mobile-controllable development environment:

### **Tier 1: Control Plane (Backend API)**
Python service running on your Mac that:
- Manages Claude Code sessions in isolated tmux containers
- Monitors terminal output in real-time
- Auto-detects when dev servers start
- Automatically creates public tunnels (via Cloudflare)
- Exposes REST API and WebSocket streams for remote access

### **Tier 2: Web Interface**
Responsive web application that provides:
- Dashboard of all active sessions
- Real-time terminal streaming
- Command input interface
- One-click access to public URLs
- Session management controls

### **Tier 3: Native Mobile Apps**
iOS and Mac apps with:
- Native push notifications
- Split-screen terminal + preview
- Quick action shortcuts
- Offline command queueing
- Rich session history

---

## 🎁 What This System Solves

### **1. True Mobile Development**
✅ Start a coding task from your phone  
✅ Check progress during lunch break  
✅ Send follow-up commands from anywhere  
✅ Preview the live app on your mobile device  
✅ No need to SSH into terminal manually  

### **2. Instant Server Access**
✅ Automatic tunnel creation when servers start  
✅ Beautiful URLs like `https://my-app-abc123.trycloudflare.com`  
✅ Preview dev servers on any device  
✅ Share links with team members instantly  
✅ No manual port forwarding configuration  

### **3. Session Persistence & Visibility**
✅ All sessions visible in one dashboard  
✅ See what's running even when disconnected  
✅ Resume sessions from any device  
✅ Full log history preserved  
✅ Track multiple projects simultaneously  

### **4. Real-Time Monitoring**
✅ Live terminal output streaming  
✅ Push notifications for key events:
   - "Server ready on port 3000"
   - "Build completed successfully"
   - "Error detected in test suite"
✅ Know when tasks complete without checking  

### **5. Asynchronous Development Workflow**
✅ Delegate tasks to Claude Code and walk away  
✅ Check in periodically from phone  
✅ Use commute time productively  
✅ Work from anywhere with just your phone  
✅ No context loss when switching devices  

### **6. Enhanced Collaboration**
✅ Share live preview links with stakeholders  
✅ Hand off sessions to team members  
✅ Review Claude's work remotely  
✅ Demo progress without screen sharing  

### **7. Development Efficiency**
✅ Less time sitting at desk waiting for builds  
✅ Catch errors faster via mobile notifications  
✅ Parallel work: start build, work on something else  
✅ Maximize use of "dead time" (waiting, commuting)  

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────┐
│           Your MacBook Pro M1               │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │  Claude Code Sessions (tmux)          │ │
│  │  • ses_project_a: Next.js app         │ │
│  │  • ses_project_b: Python API          │ │
│  │  • ses_experiment: React component    │ │
│  └───────────────────────────────────────┘ │
│                   ↕                         │
│  ┌───────────────────────────────────────┐ │
│  │  Control Plane (Python/FastAPI)       │ │
│  │  • Session management                 │ │
│  │  • Log monitoring & parsing           │ │
│  │  • Auto-tunnel creation               │ │
│  │  • WebSocket streaming                │ │
│  └───────────────────────────────────────┘ │
│                   ↕                         │
│  ┌───────────────────────────────────────┐ │
│  │  Cloudflare Tunnels                   │ │
│  │  • localhost:3000 → public URL        │ │
│  │  • localhost:8000 → public URL        │ │
│  └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
                   ↕ HTTP/WebSocket
        ┌──────────────────────────┐
        │   Your iPhone/iPad       │
        │  • Web App (Safari PWA)  │
        │  • Native iOS App        │
        │                          │
        │  Features:               │
        │  - Terminal view         │
        │  - Command input         │
        │  - Preview browser       │
        │  - Push notifications    │
        └──────────────────────────┘
```

---

## 💡 Key Features

### **Phase 1: Core Functionality**

#### Session Management
- Create new Claude Code sessions with one API call
- Each session runs in isolated tmux environment
- View all active sessions in dashboard
- Start/stop/restart sessions remotely
- Automatic cleanup when sessions end

#### Real-Time Monitoring
- Live log streaming via WebSocket
- Color-coded output (stdout, stderr, system messages)
- Pattern detection in logs (errors, warnings, completions)
- Rolling buffer of last 1000 lines
- Full log history saved to disk

#### Automatic Tunnel Creation
- Detects when Claude Code starts a dev server
- Parses output for `localhost:PORT` patterns
- Launches Cloudflare tunnel automatically
- Extracts and stores public URL
- Notifies all connected clients instantly

#### Command Execution
- Send commands to Claude Code via API
- Queue commands when session is busy
- Execute multiple commands in sequence
- View command history

#### Multiple Sessions
- Run multiple Claude Code instances simultaneously
- Each session independent with own working directory
- Switch between sessions seamlessly
- Aggregate view of all activity

### **Phase 2: Web Interface**

- Responsive dashboard for desktop and mobile
- Split-pane view: terminal + live preview
- Command palette with autocomplete
- Session cards showing status at-a-glance
- One-click URL copying and opening
- Dark mode optimized for terminal viewing

### **Phase 3: Native Apps**

#### iOS App
- Native push notifications
- Picture-in-picture terminal
- Split-view: code + preview
- Siri shortcuts integration
- Widgets showing session status
- Handoff between iPhone and Mac

#### Mac App
- Menu bar icon with quick actions
- Overlay terminal window
- Native notifications
- TouchBar integration
- Multi-window support

---

## 🎬 Use Cases & Workflows

### **Use Case 1: Async Task Delegation**

**Scenario:** You need a React component built but have a meeting in 5 minutes.

1. Open mobile app
2. Create new session: "Create a user profile card component"
3. Claude Code starts working
4. You go to meeting
5. Get notification: "Server ready - preview available"
6. During meeting break, open preview URL on phone
7. Send follow-up: "Make the avatar larger and add edit button"
8. Continue meeting
9. Get notification: "Changes deployed"
10. Review on phone, approve

**Time saved:** 30+ minutes of desk time

---

### **Use Case 2: Commute Development**

**Scenario:** 45-minute train ride home

1. On train, open web app on phone
2. Check dashboard - 3 active sessions
3. Session A: Build finished successfully
   - Open tunnel URL, test the feature
   - Works! Send command: "git commit -m 'Add feature'"
4. Session B: Error in test suite
   - Read error logs
   - Send fix command
5. Session C: Still running (long build)
   - Check progress logs
   - Looks good, leave it running

**Outcome:** 45 minutes of productive development time while commuting

---

### **Use Case 3: Stakeholder Demo**

**Scenario:** Product manager wants to see new feature

1. Claude Code built the feature earlier
2. You're in different office/city
3. Open mobile app, find the session
4. Copy public tunnel URL
5. Text URL to product manager
6. They view live on their device
7. They request changes via Slack
8. You send commands to Claude Code from phone
9. Changes deploy in real-time
10. PM refreshes browser, sees updates

**Value:** Instant demos without scheduling or screen sharing

---

### **Use Case 4: Parallel Projects**

**Scenario:** Working on multiple client projects

1. Dashboard shows:
   - ClientA_Feature: Server on port 3000
   - ClientB_Bugfix: Tests running
   - ClientC_Refactor: Idle, awaiting command
   
2. From phone:
   - Check ClientA preview, looks good
   - See ClientB tests passed, send "npm run build"
   - Give ClientC new task: "Update API docs"

3. All three progressing simultaneously
4. Mac doing heavy lifting
5. You orchestrating from anywhere

**Efficiency:** 3x project velocity

---

### **Use Case 5: Learning & Experimentation**

**Scenario:** Exploring new framework while watching TV

1. From couch with iPad
2. Create session: "Build a todo app with SvelteKit"
3. Claude Code generates project
4. Preview on iPad, looks interesting
5. "Add drag-and-drop reordering"
6. Test on iPad
7. "Now add persistence with Supabase"
8. Learn by playing, without laptop

**Benefit:** Frictionless learning and experimentation

---

## 🔧 Technical Approach

### Why These Technologies?

**Python + FastAPI:**
- Async by default (perfect for WebSockets)
- Fast development iteration
- Excellent subprocess management
- Rich ecosystem for terminal manipulation

**tmux:**
- Mature, stable session management
- Survives disconnections
- Scriptable via CLI
- Built-in logging capabilities

**Cloudflare Tunnels:**
- Free tier available
- Fast global network
- No port forwarding setup
- No firewall configuration
- Works from anywhere

**WebSockets:**
- True real-time streaming
- Bidirectional communication
- Low latency
- Native browser support

---

## 🗺️ Roadmap

### **Phase 1: Foundation (Week 1-2)**
- ✅ Backend API with session management
- ✅ tmux integration
- ✅ Log monitoring and streaming
- ✅ Auto-tunnel creation
- ✅ Basic REST endpoints
- ✅ WebSocket streaming

### **Phase 2: Web Interface (Week 3-4)**
- 📱 Responsive dashboard
- 📱 Real-time terminal component
- 📱 Command input interface
- 📱 Session management UI
- 📱 Mobile-optimized layouts
- 📱 PWA capabilities

### **Phase 3: Native Apps (Week 5-8)**
- 📱 iOS app with push notifications
- 📱 Mac menu bar app
- 📱 Widget support
- 📱 Shortcuts integration
- 📱 Handoff between devices

### **Phase 4: Advanced Features (Future)**
- 🔮 Session recording & playback
- 🔮 AI summarization of what Claude did
- 🔮 Voice control
- 🔮 Team collaboration features
- 🔮 GitHub integration
- 🔮 Cost tracking
- 🔮 Performance metrics
- 🔮 Alternative tunnel providers (ngrok)

---

## 🎯 Success Metrics

### Quantitative
- **Time to productivity:** < 30 seconds from phone to controlling Claude Code
- **Notification latency:** < 5 seconds from event to mobile alert
- **Tunnel creation time:** < 10 seconds from server start to public URL
- **Concurrent sessions:** Support 5+ simultaneous sessions
- **Mobile usage:** 50%+ of interactions happen from mobile device

### Qualitative
- **Developer happiness:** "I can code from anywhere"
- **Productivity:** "I get more done in less desk time"
- **Flexibility:** "I work on my schedule, not my computer's"
- **Confidence:** "I trust Claude Code to work while I'm away"

---

## 🚀 Why This Matters

This project fundamentally changes the relationship between developer and AI coding assistant:

**From:** Synchronous, desk-bound collaboration  
**To:** Asynchronous, location-independent orchestration

**From:** "I need to sit here and watch this build"  
**To:** "I'll check on it from my phone when I'm ready"

**From:** "Can't show this to anyone until I'm at my computer"  
**To:** "Here's the link, view it on your device"

**From:** "Lost an hour waiting for Claude to finish"  
**To:** "Used that hour productively, got notified when ready"

---

## 🎓 What You'll Learn

Building this project provides hands-on experience with:

- **Process management:** tmux, subprocess, session isolation
- **Real-time systems:** WebSockets, async streaming
- **Network tunneling:** Cloudflare, ngrok, proxy patterns
- **Mobile development:** iOS native, responsive web, PWAs
- **API design:** REST, WebSocket, event-driven architecture
- **DevOps:** Service management, logging, monitoring
- **Full-stack development:** Backend, frontend, mobile integration

---

## 📝 Future Vision

Imagine:
- Voice command: "Hey Siri, start a new Claude Code session for the homepage redesign"
- Notification: "Your React app is ready - preview at [link]"
- On couch: Review the app, send refinement requests
- Notification: "Updates deployed"
- Approve and deploy to production
- All without touching your laptop

**This is the future of AI-assisted development: ambient, asynchronous, accessible.**

---

## 🤝 Who This Is For

- **Solo developers** who want flexibility in when/where they work
- **Remote teams** needing easy preview sharing
- **Consultants** managing multiple client projects
- **Experimenters** who code during "down time"
- **Anyone** tired of being chained to their desk while Claude Code works

---

## 🎉 The Big Picture

**Claude Code Remote Controller** transforms your Mac into a development server that you can orchestrate from your phone. It's about **reclaiming your time, increasing flexibility, and making AI-assisted development work around your life** - not the other way around.

You're not just building a tool; you're creating a new way of working that's more humane, more flexible, and ultimately more productive.

**Let's build it.** 🚀