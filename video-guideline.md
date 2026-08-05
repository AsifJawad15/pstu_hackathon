# Aegis Grid — 4-Minute Video Production Runbook & Guideline

এই নির্দেশিকাটি `Hackathon Preli Question Set.pdf`-এর ভিডিও সাবমিশন নিয়মাবলি (Video Submission Rules) এবং বর্তমান **Aegis Grid**-এর লাইভ Web Command Console (`http://127.0.0.1:8181`) ও Docker প্রোডাকশন আর্কিটেকচার অনুসারে তৈরি করা হয়েছে। 

এই ডকুমেন্টটির মূল উদ্দেশ্য হলো—বিচারক (Judge)-দের সামনে **৪ মিনিটের কম সময়ে** আমাদের সমস্যা, ইঞ্জিনিয়ারিং সিদ্ধান্ত, লাইভ ওয়র্কিং ডেমোনস্ট্রেশন, রিলায়েবিলিটি এবং পরিমাপযোগ্য প্রমাণ (measurable evidence) অত্যন্ত সাবলীল ও স্পষ্ট ভাষায় উপস্থাপন করা।

---

## 1. 🚨 PDF থেকে বাধ্যতামূলক নিয়ম ও শর্তাবলি (Must-Follow Rules)

> [!WARNING]  
> **অ্যানোনিমাইজেশন ও ফরম্যাট সতর্কতা:** হ্যাক্যাথনের প্রাথমিক পর্বে বিচার কাজের স্বচ্ছতার জন্য নিচের নিয়মগুলো কঠোরভাবে মেনে চলতে হবে। কোনো ব্যত্যয় ঘটলে সাবমিশন বাতিল হতে পারে!

| বিষয় | হ্যাক্যাথন বাধ্যবাধকতা (PDF Rule) | আমাদের নিরাপদ টার্গেট |
| :--- | :--- | :--- |
| **ভিডিওর দৈর্ঘ্য (Duration)** | সর্বোচ্চ **৪ মিনিট (4:00)** | **৩:৪৫ থেকে ৩:৫৫ মিনিট** |
| **ভিডিও ফরম্যাট (Format)** | শুধুমাত্র **MP4 (.mp4)** | **Standard MP4 (H.264 / AAC)** |
| **ফাইল সাইজ (File Size)** | **৪০০ MB-এর কম** (< 400 MB) | **১৫০ থেকে ২২০ MB** |
| **ফাইলের নাম (Filename)** | শুধুমাত্র Assigned Registration ID | `<REGISTRATION-ID>.mp4` (যেমন: `12345.mp4`) |
| **পরিচয় প্রকাশ (Anonymity)** | টিম নাম, সদস্য নাম বা বিশ্ববিদ্যালয়ের নাম প্রকাশ সম্পূর্ণ নিষিদ্ধ | ভিডিও, স্ক্রিন, কোড বা আলাপে কোথাও কোনো পরিচয় দেখানো বা বলা যাবে না |
| **সাবমিশন ডেডলাইন** | **৬ আগস্ট ২০২৬, রাত ১১:৫৯** | ডেডলাইনের অন্তত ১-২ ঘণ্টা আগে আপলোড সম্পন্ন করা |
| **সোর্স কোড প্রদর্শন** | প্রাথমিক পর্বে সোর্স কোড দেখানো বাধ্যতামূলক নয় | কোড এডিটর না দেখিয়ে **রানিং সিস্টেম, কনসোল ও Grafana Evidence** দেখানো হবে |

---

## 2. 📊 Master Video Timelines (ভিডিও কাঠামোর রূপরেখা)

| সময়সীমা | দৃশ্য (Scene) | মূল ফোকাস | ন্যারেশন ফাইল (`speech.md`) সিঙ্ক |
| :---: | :--- | :--- | :--- |
| **0:00 - 0:20** | **1. Problem Hook** | কেন সাধারণ nearest-ambulance সিস্টেম বড় দুর্যোগে ব্যর্থ হয় | "একটি বড় দুর্যোগে শুধু সবচেয়ে কাছের অ্যাম্বুলেন্স..." |
| **0:20 - 0:48** | **2. Solution Overview** | Aegis Grid-এর bounded regional decision loop ও ল্যাটেন্সি টার্গেট | "Aegis Grid সমস্যাটিকে একটি bounded regional..." |
| **0:48 - 1:25** | **3. Architecture & Flow** | Regional autonomy, PostgreSQL/PostGIS, Kafka, Redis, etcd, Optimizer | "প্রতিটি region একটি autonomous safety cell..." |
| **1:25 - 2:05** | **4. Live Demonstration** | Prepare baseline, P0 Critical Medical allocation, Incident Inspector | "এখন live scenario দেখা যাক। Baseline-এ..." |
| **2:05 - 2:38** | **5. Dynamic Adaptation** | Road collapse ও bounded re-optimization (No thrashing) | "Emergency environment স্থির নয়..." |
| **2:38 - 3:12** | **6. Reliability & Scaling** | Fencing epoch, Sharding, Outbox event retention ও fallback | "আমাদের সবচেয়ে গুরুত্বপূর্ণ invariant..." |
| **3:12 - 3:38** | **7. Measured Evidence** | Grafana monitoring, 46 safety tests, p99 ≈ 27 ms, 0 outbox backlog | "Grafana-তে request rate, critical acceptance..." |
| **3:38 - 3:50** | **8. Conclusion** | Production architecture boundary ও ভবিষ্যৎ ফিল্ড টেস্টিং | "Aegis Grid দ্রুত, explainable এবং failure-tolerant..." |

> **সর্বমোট টার্গেট সময়:** **৩ মিনিট ৫০ সেকেন্ড**।

---

## 3. 🛠️ রেকর্ডিংয়ের আগে সিস্টেম প্রস্তুতি (Pre-Flight Setup)

ভিডিও রেকর্ডিং শুরু করার আগে নিশ্চিত করুন আপনার ল্যাপটপে **Docker Desktop** চালু আছে। প্রজেক্ট ডিরেক্টরিতে PowerShell থেকে নিচের কমান্ডগুলো চালিয়ে সিস্টেম রেডি করুন:

```powershell
# 1. সার্ভিসগুলো চালু করুন
npm run docker:up

# 2. সার্ভিস স্ট্যাটাস চেক করুন (সবগুলো Healthy কি না)
npm run docker:status

# 3. স্মোক টেস্ট চালিয়ে সিস্টেমের এন্ড-টু-এন্ড ইন্টিগ্রেশন নিশ্চিত করুন
npm run docker:smoke
```

### যাচাইকৃত এন্ডপয়েন্ট ও স্ট্যাটাস:
- **Command Console:** `http://127.0.0.1:8181`
- **Grafana Monitoring:** `http://127.0.0.1:3000` (User: `admin`)
- **Prometheus Metrics:** `http://127.0.0.1:9090`
- কনসোলের **05 Infrastructure** সেকশনে API, PostgreSQL, Kafka brokers, Redis এবং etcd members **HEALTHY** দেখাচ্ছে।

### 🔑 সিকিউর টোকেন লগইন (ভিডিওতে টার্মিনাল না দেখিয়ে):
ভিডিওতে কোনো প্রকার `.env` ফাইল বা কমান্ড লাইন টোকেন দেখানো যাবে না। রেকর্ডিং শুরুর আগেই টোকেনটি ক্লিপবোর্ডে কপি করুন:

```powershell
$apiToken = ((Get-Content .env | Where-Object { $_ -match '^EMERGENCY_API_TOKEN=' }) -replace '^EMERGENCY_API_TOKEN=', '').Trim()
$apiToken | Set-Clipboard
```
ব্রাউজারে `http://127.0.0.1:8181` ওপেন করে **API token** ফিল্ডে পেস্ট করুন (এটি পাসওয়ার্ড হিসেবে masked থাকবে) এবং **Connect** চাপুন। স্ট্যাটাস "Secure link established" হলে ব্রাউজার রেডি!

---

## 4. 🛡️ প্রাইভেসী ও অ্যানোনিমাইজেশন প্রটোকল (Strict Privacy Setup)

> [!IMPORTANT]  
> এটি রেকর্ডিংয়ের সবচেয়ে গুরুত্বপূর্ণ চেক। ব্রাউজার বা স্ক্রিনে আপনার ব্যক্তিগত বা প্রাতিষ্ঠানিক তথ্য প্রকাশ পেলে বিচারক নিয়মানুযায়ী ডিসকোয়ালিফাই করতে বাধ্য হতে পারেন।

1. **ব্রাউজার ক্লিনअप:** ব্রাউজারের বুকমার্ক বার (Bookmarks Bar), এক্সটেনশন আইকন এবং পার্সোনাল প্রোফাইল ফটো বা ইমেইল লুকিয়ে রাখুন அல்லது একটি সম্পূর্ণ নতুন Incognito/Guest উইন্ডো ব্যবহার করুন।
2. **ফুলস্ক্রিন বা ক্লিন ক্রপ:** উইন্ডোজের টাস্কবার (Taskbar), ডেস্কটপ ব্যাকগ্রাউন্ড বা টার্মিনাল প্রম্পট দেখাবেন না। ব্রাউজারকে Full-Screen (F11) করে রেকর্ডিং করাই সবচেয়ে নিরাপদ।
3. **ফাইল পাথ সতর্কতা:** কোনো কারণে ফাইল পাথ দেখাতে হলে খেয়াল রাখবেন যেন তাতে আপনার নাম বা বিশ্ববিদ্যালয়ের নাম (যেমন: `C:\Users\JohnDoe\DhakaUniversity\`) না থাকে।
4. **প্রোডাক্ট নেম vs টিম নেম:** শুধুমাত্র আমাদের সিস্টেমের নাম **"Aegis Grid"** প্রদর্শন করা যাবে; এটিকে কোথাও টিম নেম হিসেবে উপস্থাপন করবেন না।
5. **পাসওয়ার্ড গোপনীয়তা:** API token, Grafana admin password বা command-signing key কখনো unmask করবেন না।

---

## 5. 🎬 Scene-by-Scene Director's Script & Action Plan

### 📍 Scene 1: Problem Hook (0:00 - 0:20)
* **🎯 উদ্দেশ্য:** বিচারককে বোঝানো যে দুর্যোগকালীন জরুরি মুহূর্তে শুধুমাত্র "নিকটবর্তী অ্যাম্বুলেন্স" খোঁজার কৌশল কেন ঝুঁকিপূর্ণ।
* **🖥️ স্ক্রিন অ্যাকশন:** একটি ক্লিন ও প্রফেশনাল টাইটেল কার্ড বা প্রেজেন্টেশন স্লাইড প্রদর্শন করুন যেখানে লেখা থাকবে:
  ```
  Aegis Grid
  Fast response · Conflict-safe allocation · Regional continuity
  ```
* **✨ ভিজ্যুয়াল টিপস:** ধীর ও মসৃণ জুম-ইন (Zoom-in)। স্ক্রিনে কোনো দীর্ঘ টেক্সট বা প্যারাগ্রাফ রাখবেন না।

---

### 📍 Scene 2: Solution Overview (0:20 - 0:48)
* **🎯 উদ্দেশ্য:** Aegis Grid কীভাবে এই জটিলতাকে একটি bounded regional decision loop দ্বারা সমাধান করে তা দেখানো।
* **🖥️ স্ক্রিন অ্যাকশন:** Aegis Grid Console-এর **01 Overview** সেকশনে যান। স্ক্রিনের ডানদিকে "One bounded response loop"-এর ওপর মাউস কার্সারটি ধীরে ধীরে সরান:
  `01 Ingest → 02 Prioritize → 03 Allocate → 04 Reserve → 05 Dispatch → 06 Adapt`
* **✨ ভিজ্যুয়াল টিপস:** নিচের ল্যাটেন্সি টার্গেটগুলোর ওপর হালকা হাইলাইট দিন:
  - `≤50 ms Intake p99 target`
  - `≤100 ms Feasible decision`
  - `0 Double assignments`

---

### 📍 Scene 3: Architecture and Data Flow (0:48 - 1:25)
* **🎯 উদ্দেশ্য:** আমাদের ডিস্ট্রিবিউটেড এবং রিলায়েবল ডাটা প্লেন বিচারকের সামনে স্পষ্ট করা।
* **🖥️ স্ক্রিন অ্যাকশন:** কনসোলের **05 Infrastructure** (Resilience Topology) সেকশনে নেভিগেট করুন। মাউসের কার্সার দিয়ে নিচের কার্ডগুলো ধারাবাহিকভাবে পয়েন্ট করুন:
  1. **Regional Safety Core:** Deterministic API + Transactional Outbox
  2. **01 Durability:** PostgreSQL / PostGIS (Replayable operational events)
  3. **02 Backbone:** Kafka (3 Brokers, RF=3, ISR=2)
  4. **03 Speed:** Redis Projection (Disposable cache)
  5. **04 Ownership:** etcd (3 Members Quorum)
  6. **05 Intelligence:** Python Exact Optimizer
* **✨ ভিজ্যুয়াল টিপস:** স্পষ্ট করুন যে Redis বা Optimizer বন্ধ হয়ে গেলেও local deterministic fallback দ্বারা কাজ চলে, কোনো সিঙ্গল পয়েন্ট অব ফেইলিউর নেই।

---

### 📍 Scene 4: Live Emergency Allocation (1:25 - 2:05)
* **🎯 উদ্দেশ্য:** লাইভ সিস্টেমে একটি জরুরি ঘটনা কীভাবে ফিল্টার, রিজার্ভ ও ডিসপ্যাচ হয় তা সরাসরি দেখানো।
* **🖥️ স্ক্রিন অ্যাকশন:**
  1. কনসোলের **02 Response lab**-এ নেভিগেট করুন।
  2. **Prepare baseline** বাটনে ক্লিক করুন। (ডানদিকের Timeline-এ `Baseline ready` এবং উপরের মেট্রিকে `Resources ready` ও `Facility headroom` বৃদ্ধি প্রদর্শন করুন)।
  3. এরপর **P0 Critical medical** বাটনে ক্লিক করুন।
  4. টাইমলাইনে তাৎক্ষণিক P0 অ্যাসাইনমেন্ট এবং মিলি-সেকেন্ডের ল্যাটেন্সি লক্ষ্য করুন।
  5. **03 Incidents / Evidence** সেকশনে গিয়ে নতুন incident-টিতে ক্লিক করে **Incident Inspector** খুলুন।
  6. Inspector-এ decision mode, fencing epoch, policy version এবং route evidence দেখান।
* **⚠️ Do's and Don'ts:** Raw JSON-এর ভেতরে বেশি সময় নষ্ট না করে বিচারকদের চোখ সরাসরি `Fencing Epoch`, `Decision Mode` এবং `Route Evidence`-এর দিকে আকর্ষণ করুন।

---

### 📍 Scene 5: Dynamic Adaptation & Anti-Thrashing (2:05 - 2:38)
* **🎯 উদ্দেশ্য:** পরিবর্তিত পরিস্থিতিতে (যেমন রাস্তা ভেঙে যাওয়া) সিস্টেম কীভাবে স্মার্ট সিদ্ধান্ত নেয় এবং অপ্রয়োজনীয় রিশেডিউলিং (thrashing) প্রতিরোধ করে তা দেখানো।
* **🖥️ স্ক্রিন অ্যাকশন:**
  1. Response Lab-এ **MAP - Road collapse** বাটনে ক্লিক করুন (টাইমলাইনে closure `APPLIED` লক্ষ্য করুন)।
  2. এরপর **OPT - Re-optimize** বাটনে ক্লিক করুন।
  3. Inspector-এ গিয়ে Re-optimization-এর outcome (`KEEP` বা `RECOMMEND`) এবং তার পেছনের স্পষ্ট কারণ (reason string) প্রদর্শন করুন।
* **✨ ভিজ্যুয়াল টিপস:** ব্যাখ্যা করুন যে Ground Route বন্ধ হওয়ায় টার্গেটেড ইভোলিউশন শুরু হয়েছে, কিন্তু ছোটখাটো পরিবর্তনে আমরা চলমান অ্যাম্বুলেন্সকে ঘুরিয়ে দেই না।

---

### 📍 Scene 6: Reliability, Scaling and Recovery (2:38 - 3:12)
* **🎯 উদ্দেশ্য:** কনফ্লিন্ট প্রতিরোধ ও ফেইলওভার ক্যাপাবিলিটি প্রমাণ করা।
* **🖥️ স্ক্রিন অ্যাকশন:**
  1. **05 Infrastructure** সেকশনের আউটবক্স এবং টপোলজি ম্যাপ দেখান। 
  2. এডিটিং ওভারলে-তে নিচের টেক্সটটি প্রদর্শন করুন:
     ```
     256 Virtual Shards per Region
     Atomic Fencing Tokens & Expected Versions
     At-least-once Delivery + Idempotent Replay
     ```
  3. *(ঐচ্ছিক)* যদি ডেমোতে নেটওয়ার্ক ইন্টারাপশন বা রিটেইনড ইভেন্ট দেখাতে চান, তবে **Retry retained events** বাটনে ক্লিকের মাধ্যমে আউটবক্স ব্যাকলগ শূন্যে ফিরে আসার দৃশ্য দেখাতে পারেন।

---

### 📍 Scene 7: Monitoring and Measured Evidence (3:12 - 3:38)
* **🎯 উদ্দেশ্য:** পরিমাপযোগ্য ফলাফল ও টেস্ট স্যুট পাসের প্রমাণ প্রদর্শন।
* **🖥️ স্ক্রিন অ্যাকশন:**
  1. ব্রাউজারের ট্যাব স্যুইচ করে **Grafana Dashboard** (`http://127.0.0.1:3000/d/aegis-regional-reliability`) ওপেন করুন।
  2. Grafana-এর request rate, P0 acceptance, integration health এবং event backlog গ্রাফগুলো পয়েন্ট করুন।
  3. ভিডিওর নিচে বা পাশে একটি স্পষ্ট টেক্সট ওভারলে বসান:
     ```
     ✔️ 46 / 46 Automated Safety Tests Passed
     ✔️ 25 Simultaneous Concurrent Claims → Exactly 1 Exclusive Winner
     ✔️ Public API Intake p99 Latency ≈ 27 ms
     ✔️ Transactional Outbox Backlog = 0
     ```

---

### 📍 Scene 8: Conclusion & Safety Boundary (3:38 - 3:50)
* **🎯 উদ্দেশ্য:** সততা ও দায়িত্বশীলতার সাথে আমাদের প্রোডাকশন আর্কিটেকচার বাউন্ডারি এবং পরবর্তী ধাপগুলো তুলে ধরা।
* **🖥️ স্ক্রিন অ্যাকশন:** কনসোলের **01 Overview** সেকশনে ফিরে আসুন অথবা একটি ক্লিন এন্ডিং কার্ড দেখান:
  ```
  Aegis Grid
  First safe response. Then continuously improve.
  ```
* **✨ ভিজ্যুয়াল টিপস:** ধীর ফেইড-আউট (Fade-out) ট্রানজিশন ব্যবহার করুন।

---

## 6. 🎨 Visual Style & Production Polish

1. **রেজোলিউশন ও রেশিও:** **1920×1080 (Full HD)**, 16:9 Aspect Ratio।
2. **ফ্রেম রেট:** **30 fps** (স্ক্রিন কাস্টের জন্য এটি সবচেয়ে আদর্শ ও পারফেক্ট)।
3. **ব্রাউজার জুম:** জুম 100% রাখুন (ছোট মনিটর হলে 90% করতে পারেন, তবে কোনো লেখা যেন অস্পষ্ট বা অতি ক্ষুদ্র না হয়)।
4. **মাউস মুভমেন্ট:** কার্সার খুব দ্রুত নাড়িয়ে অস্থিরতা তৈরি করবেন না। বাটনে ক্লিকের পরে বিচারককে দেখার জন্য ১-২ সেকেন্ড অপেক্ষা করুন।
5. **হাইলাইট ও জুম:** ভিডিও এডিটরের সাহায্যে গুরুত্বপূর্ণ মেট্রিকে (যেমন: p99 ল্যাটেন্সি বা Fencing Epoch) হালকা জুম বা গোল হাইলাইট ফ্রেম যুক্ত করুন।
6. **ব্যাকগ্রাউন্ড মিউজিক:** যদি হালকা ব্যাকগ্রাউন্ড মিউজিক ব্যবহার করেন, তবে খেয়াল রাখবেন তা যেন ভয়েসের তুলনায় অন্তত **-18 dB থেকে -22 dB নিচে** থাকে। ভয়েস সর্বদা পরিষ্কার শুনতে হবে।
7. **ট্রানজিশন:** সিন পরিবর্তনের সময় ১৫০০-২৫০ মিলি-সেকেন্ডের সাধারণ কাট বা স্মুথ ডিজলভ (Dissolve) ব্যবহার করুন; কোনো নাটকীয় বা ফ্ল্যাশি ট্রানজিশন (যেমন: Spin/Wipe) এড়িয়ে চলুন।

---

## 7. ⚙️ Export Settings (ভিডিও রেন্ডারিং স্পেসিফিকেশন)

ভিডিও এডিট (Premiere Pro, DaVinci Resolve, CapCut বা Camtasia) শেষে এক্সপোর্টের সময় নিচের প্যারামিটারগুলো নিশ্চিত করুন:

- **Container:** MP4 (.mp4)
- **Video Codec:** H.264 (High Profile)
- **Resolution:** 1920×1080
- **Frame Rate:** 30 fps
- **Target Video Bitrate:** 5 Mbps থেকে 7 Mbps (এর বেশি দিলে ফাইল সাইজ খামাকা বড় হবে)
- **Audio Codec:** AAC, 48 kHz, Stereo, 160–192 kbps
- **Estimated File Size:** ৩ মিনিট ৫০ সেকেন্ডের জন্য আনুমানিক **১৫০ থেকে ২২০ MB** (যাচাই করুন যেন ৪০০ MB ছাড়িয়ে না যায়)।

---

## 8. 🚨 Emergency Contingency & Backup Plan (ঝুঁকি ব্যবস্থাপনা)

- **অফলাইন ব্যাকআপ ক্লিপ:** লাইভ রেকর্ডিংয়ের সময় পিসি বা ডকার স্লো হয়ে গেলে যেন পুরো মেহনত বৃথা না যায়, সেজন্য আগে থেকেই Successful Allocation, Incident Inspector এবং Grafana Dashboard-এর তিনটি ক্লিন স্ক্রিন রেকর্ডিং ক্লিপ ব্যাকআপ রেখে দিন।
- **টুকরা টুকরা রেকর্ডিং:** এক টেকেই (One-take) পুরো ৪ মিনিট নির্ভুলভাবে বলা কঠিন। প্রতিটি সিন আলাদা করে রেকর্ড করুন এবং পরে এডিটরে জোড়া লাগান। এতে কথা বলার কনফিডেন্স অনেক বাড়বে।
- **কম্প্রেশন ব্যাকআপ:** মূল এক্সপোর্ট করা ফাইলটির পাশাপাশি Handbrake বা Clipchamp দিয়ে আরেকটি Slightly Compressed Copy তৈরি করে রাখবেন যেন আপলোডের সময় ইন্টারনেট বা সার্ভার ইস্যুতে বড় ফাইল আপলোড হতে সমস্যা হলে দ্রুত ব্যাকআপ ফাইল সাবমিট করা যায়।

---

## 9. ✔️ Final Submission Verification Checklist

আপলোডের বোতামে ক্লিক করার আগে নিচের প্রতিটি বক্স মিলিয়ে নিন:

- [ ] ভিডিওর মোট দৈর্ঘ্য ঠিক **৪:০০ মিনিটের কম** (নিরাপদ: ৩:৪৫-৩:৫৫)।
- [ ] ভিডিও ফরম্যাট **MP4 (.mp4)**।
- [ ] ফাইল সাইজ **৪০০ MB-এর নিচে**।
- [ ] ফাইলের নাম হুবহু রেজিস্ট্রেশন আইডি অনুযায়ী রাখা হয়েছে (যেমন: `<REGISTRATION-ID>.mp4`)।
- [ ] ভিডিওর কোথাও কোনো **টিমের নাম** লেখা বা বলা হয়নি।
- [ ] কোথাও কোনো **সদস্যের নাম বা ছবি** প্রদর্শিত হয়নি।
- [ ] কোনো **বিশ্বविद्यालय বা প্রতিষ্ঠানের নাম বা লোগো** প্রকাশ পায়নি।
- [ ] ব্রাউজার বুকমার্ক বার, পার্সোনাল প্রোফাইল আইকন ও নোটিফিকেশন বন্ধ রাখা হয়েছে।
- [ ] `.env` ফাইলের সিক্রেট, পাসওয়ার্ড বা টোকেনের unmasked রূপ কোথাও দেখানো হয়নি।
- [ ] ভয়েস ও ন্যারেশন অত্যন্ত পরিষ্কার এবং ব্যাকগ্রাউন্ড মিউজিক ভয়েসকে ঢেকে দেয়নি।
- [ ] ডেমোতে P0 allocation, Inspector evidence এবং Fencing Epoch স্পষ্টভাবে দৃশ্যমান।
- [ ] Grafana Monitoring এবং 46 Safety Tests পাসের প্রমাণ প্রদর্শিত হয়েছে।
- [ ] পুরো রেন্ডার করা MP4 ফাইলটি শুরু থেকে শেষ পর্যন্ত চালিয়ে একবার অডিও-ভিজ্যুয়াল সিঙ্ক যাচাই করা হয়েছে।
- [ ] রেজিস্ট্রেশনকৃত ইমেইল আইডি থেকেই ডেডলাইন (৬ আগস্ট, ২০২৬ রাত ১১:৫৯)-এর আগে সাবমিট করা হচ্ছে।

---
*Aegis Grid — Prototyped with Reliability & Speed in Mind.*
