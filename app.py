from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_socketio import SocketIO
import time
import sqlite3
from datetime import datetime
from collections import deque
from threading import Lock

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# ---------- CONFIG ----------
NORMAL_GREEN = 30
YELLOW_TIME = 5

# ---------- GLOBAL STATE ----------
lanes_state = {
    1: {"color": "red", "time_left": 0},
    2: {"color": "red", "time_left": 0},
    3: {"color": "red", "time_left": 0},
    4: {"color": "red", "time_left": 0},
}
waiting_time = {1: 0, 2: 0, 3: 0, 4: 0}

state_lock = Lock()

current_lane = 1
time_left = NORMAL_GREEN
cycle_paused = False
paused_state = {"lane": None, "remaining_time": 0}
request_queue = deque()

# ✅ Instead of single skip_lane_once, use a SET
skip_lanes = set()

# ---------- DATABASE ----------
DB_FILE = "ambulance.db"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Existing logs table (kept same)
    c.execute("""CREATE TABLE IF NOT EXISTS logs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_name TEXT,
        vehicle_number TEXT,
        lane INTEGER,
        duration INTEGER,
        timestamp TEXT
    )""")

    # ✅ New dedicated Drivers Table
    c.execute("""CREATE TABLE IF NOT EXISTS drivers(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        vehicle_number TEXT NOT NULL UNIQUE,
        lane INTEGER,
        authorized INTEGER DEFAULT 1
    )""")

    conn.commit()
    conn.close()
def preload_drivers():
    """Insert sample authorized ambulance drivers (only once)."""
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # ✅ Replace these sample drivers with your real ambulance details
    sample_drivers = [
        ("Ravi Kumar", "KA05MB1234", 1, 1),
        ("Suma Patil", "KA09CL5678", 2, 1),
        ("Amit Singh", "KA11BN7890", 3, 1),
        ("Deepak Shetty", "KA03AD4567", 4, 1),
        ("Manjunath Gowda", "KA07CE9823", 1, 1),
        ("Praveen Rao", "KA02FD6710", 2, 1),
        ("Kiran Kumar", "KA10BL2244", 3, 1),
        ("Vivek Naik", "KA08MR9988", 4, 1),
        ("Santosh Reddy", "KA01JJ4455", 1, 1),
        ("Naveen Raj", "KA06NP7621", 2, 1),
        ("Harish Babu", "KA04CL3901", 3, 1),
        ("Rakesh Yadav", "KA12AB5550", 4, 1),
        ("Vikram S", "KA05MN1122", 1, 1),
        ("Ganesh Patil", "KA09BG8765", 2, 1),
        ("Anil Kumar", "KA11CY5643", 3, 1),
        ("Lokesh R", "KA03MP2211", 4, 1),
        ("Rajesh Hegde", "KA02LK4312", 1, 1),
        ("Chandru R", "KA07HG6620", 2, 1),
        ("Suresh Naidu", "KA08TR8888", 3, 1),
        ("Murali Mohan", "KA06AA9090", 4, 1),
        ("Rohit Kulkarni", "KA10ER1230", 1, 1),
        ("Umesh B", "KA09FT7755", 2, 1),
        ("Nagaraj P", "KA11BG6677", 3, 1),
        ("Shashank Shetty", "KA04NR3410", 4, 1),
        ("Vinod Kumar", "KA05PM5588", 1, 1),
    ]

    # ✅ Add them only if not already present
    c.executemany(
        "INSERT OR IGNORE INTO drivers(name, vehicle_number, lane, authorized) VALUES (?, ?, ?, ?)",
        sample_drivers
    )

    conn.commit()
    conn.close()

def insert_log(name, vehicle, lane, duration):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        "INSERT INTO logs(driver_name,vehicle_number,lane,duration,timestamp) VALUES(?,?,?,?,?)",
        (name, vehicle, lane, duration, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    conn.commit()
    conn.close()

# ---------- UI UPDATE ----------
def broadcast_state():
    with state_lock:
        payload = {"lanes": {k: dict(v) for k, v in lanes_state.items()}, "queue": list(request_queue)}
    socketio.emit("state_update", payload)

def update_red_lane_countdowns():
    for ln in range(1, 5):
        if ln != current_lane:
            # Don't override "—" values during emergency
            if isinstance(lanes_state[ln]["time_left"], str):
                continue

            steps_away = (ln - current_lane) % 4
            if steps_away == 0:
                steps_away = 4
            remaining = time_left + (steps_away - 1) * (NORMAL_GREEN + YELLOW_TIME) + YELLOW_TIME
            lanes_state[ln]["time_left"] = remaining

# ---------- MAIN CONTROLLER ----------
def traffic_controller():
    global current_lane, time_left, cycle_paused, paused_state, skip_lanes

    # Initial Startup
    with state_lock:
        current_lane = 1
        time_left = NORMAL_GREEN
        for i in range(1, 5):
            lanes_state[i] = {"color": "green" if i == 1 else "red", "time_left": NORMAL_GREEN if i == 1 else 0}
    broadcast_state()

    while True:
        # 🚑 EMERGENCY HANDLING
        if request_queue:
            served_lanes = set()
            with state_lock:
                if not cycle_paused:
                    cycle_paused = True
                    paused_state["lane"] = current_lane
                    paused_state["remaining_time"] = time_left
                paused_lane = paused_state["lane"]
                for i in range(1, 5):
                    lanes_state[i] = {"color": "yellow" if i == paused_lane else "red",
                                      "time_left": YELLOW_TIME if i == paused_lane else 0}
            broadcast_state()

            # Yellow pause before ambulance
            for t in range(YELLOW_TIME, 0, -1):
                time.sleep(1)
                with state_lock:
                    lanes_state[paused_lane]["time_left"] = t - 1
                    for ln in range(1, 5):
                        if ln != paused_lane and lanes_state[ln]["time_left"] > 0:
                            lanes_state[ln]["time_left"] -= 1
                    update_red_lane_countdowns()
                broadcast_state()

        
            # Serve all ambulance requests (possibly multiple)
            while request_queue:
                # 🔹 DO NOT remove from queue yet – keep it visible as active emergency
                with state_lock:
                    req = request_queue[0]   # peek, don't popleft yet

                lane = int(req["lane"])
                duration = int(req["duration"])
                served_lanes.add(lane)

                # 🔹 Make only this lane green, others red with "—"
                with state_lock:
                    for i in range(1, 5):
                        if i == lane:
                            lanes_state[i] = {"color": "green", "time_left": duration}
                        else:
                            lanes_state[i] = {"color": "red", "time_left": "—"}
                broadcast_state()

                # 🔹 GREEN countdown for this ambulance lane
                for s in range(duration, 0, -1):
                    time.sleep(1)
                    with state_lock:
                        lanes_state[lane]["color"] = "green"
                        lanes_state[lane]["time_left"] = s - 1

                        for ln in range(1, 5):
                            if ln != lane:
                                lanes_state[ln]["color"] = "red"
                                lanes_state[ln]["time_left"] = "—"
                    broadcast_state()

                # 🔹 YELLOW phase after ambulance
                with state_lock:
                    lanes_state[lane] = {"color": "yellow", "time_left": YELLOW_TIME}
                broadcast_state()

                for t in range(YELLOW_TIME, 0, -1):
                    time.sleep(1)
                    with state_lock:
                        lanes_state[lane]["color"] = "yellow"
                        lanes_state[lane]["time_left"] = t - 1
                        for ln in range(1, 5):
                            if ln != lane:
                                lanes_state[ln]["color"] = "red"
                                lanes_state[ln]["time_left"] = "—"
                    broadcast_state()

                # 🔹 Now emergency is fully served → remove it from queue
                with state_lock:
                    if request_queue:
                        request_queue.popleft()
                broadcast_state()
                # Yellow after each ambulance
                with state_lock:
                    lanes_state[lane] = {"color": "yellow", "time_left": YELLOW_TIME}
                broadcast_state()

                for t in range(YELLOW_TIME, 0, -1):
                    time.sleep(1)
                    with state_lock:
        # Keep ambulance lane yellow and countdown
                        lanes_state[lane]["color"] = "yellow"
                        lanes_state[lane]["time_left"] = t - 1

        # All other lanes remain red and dashed
                        for ln in range(1, 5):
                            if ln != lane:
                                lanes_state[ln]["color"] = "red"
                                lanes_state[ln]["time_left"] = "—"

                    broadcast_state()

            # ✅ Resume normal cycle & skip all ambulance lanes once
            # ✅ Resume normal cycle & skip all ambulance lanes once
            # ✅ Resume normal cycle & skip all ambulance lanes once
            with state_lock:
                cycle_paused = False
                resumed_lane = paused_state["lane"]
                remaining_time = paused_state["remaining_time"]

    # ✅ Skip all ambulance-served lanes once
                skip_lanes.update(served_lanes)

    # ✅ Reset waiting counters
                for ln in waiting_time:
                    waiting_time[ln] = 0

    # ✅ Resume exactly from where it was paused
                for ln in range(1, 5):
                    if ln == resumed_lane:
            # 🔹 This lane was paused mid-green → restore remaining time
                        lanes_state[ln]["color"] = "green"
                        lanes_state[ln]["time_left"] = remaining_time
                    else:
            # 🔹 Other lanes stay red and update normally
                        steps_away = (ln - resumed_lane) % 4
                        if steps_away == 0:
                            steps_away = 4
                        remaining = remaining_time + (steps_away - 1) * (NORMAL_GREEN + YELLOW_TIME) + YELLOW_TIME
                        lanes_state[ln]["color"] = "red"
                        lanes_state[ln]["time_left"] = max(remaining, 0)

    # ✅ Continue from paused point, not reset to full 30s
                current_lane = resumed_lane
                time_left = remaining_time

            broadcast_state()
            continue

        # ---------- NORMAL OPERATION ----------
        with state_lock:
            for i in range(1, 5):
                lanes_state[i] = {"color": "green", "time_left": time_left} if i == current_lane else {"color": "red", "time_left": 0}
            update_red_lane_countdowns()
        broadcast_state()

        # Countdown green
        while time_left > 0 and not request_queue:
            time.sleep(1)
            with state_lock:
                time_left -= 1
                lanes_state[current_lane]["time_left"] = time_left
                for ln in range(1, 5):
                    if ln != current_lane:
                        waiting_time[ln] += 1
                update_red_lane_countdowns()
            broadcast_state()

        if request_queue:
            continue

        # Yellow phase (normal)
        with state_lock:
            lanes_state[current_lane] = {"color": "yellow", "time_left": YELLOW_TIME}
        broadcast_state()

        for t in range(YELLOW_TIME, 0, -1):
            time.sleep(1)
            with state_lock:
        # 🔁 Update the current (yellow) lane
                lanes_state[current_lane]["time_left"] = t - 1

        # 🔁 Update red lanes’ live countdowns so they keep ticking
                for ln in range(1, 5):
                    if ln != current_lane:
                        steps_away = (ln - current_lane) % 4
                        if steps_away == 0:
                            steps_away = 4
                # Only time until that lane becomes green, excluding its own 30 s green
                        remaining = (t - 1) + (steps_away - 1) * (NORMAL_GREEN + YELLOW_TIME)
                        lanes_state[ln]["time_left"] = max(remaining, 0)

            broadcast_state()

        # Move to next lane (skip any from skip_lanes)
        with state_lock:
            next_lane = (current_lane % 4) + 1
            while next_lane in skip_lanes:  # ✅ skip any ambulance-served lanes
                skip_lanes.remove(next_lane)  # skip only once
                next_lane = (next_lane % 4) + 1
            current_lane = next_lane
            time_left = NORMAL_GREEN

# ---------- ROUTES ----------
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/drivers")
def drivers():
    return render_template("drivers.html")

@app.route("/view_logs")
def view_logs():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT * FROM logs ORDER BY id DESC")
    logs = c.fetchall()
    conn.close()
    return render_template("view_logs.html", logs=logs)

@app.route("/submit_request", methods=["POST"])
def submit_request():
    name = request.form.get("name", "Unknown")
    vehicle = request.form.get("vehicle", "")
    lane = int(request.form.get("lane", 1))
    duration = int(request.form.get("duration", 30))

    # ✅ Check if the vehicle is authorized (flexible: can request from any lane)
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT authorized FROM drivers WHERE vehicle_number=?", (vehicle,))
    result = c.fetchone()
    conn.close()

    # 🚫 Block if the vehicle is not authorized or not in the list
    if not result or result[0] != 1:
        return "❌ Unauthorized vehicle. Only registered ambulances can send emergency requests.", 403

    # ✅ If authorized, continue as normal
    insert_log(name, vehicle, lane, duration)

    req = {
        "lane": lane,
        "duration": duration,
        "driver": name,
        "vehicle": vehicle,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }

    with state_lock:
        request_queue.append(req)

    broadcast_state()
    return redirect(url_for("index"))

@app.route("/get_state")
def get_state():
    with state_lock:
        return jsonify({"lanes": lanes_state, "queue": list(request_queue)})

@socketio.on("connect")
def on_connect():
    broadcast_state()

if __name__ == "__main__":
    init_db()
    preload_drivers()
    socketio.start_background_task(traffic_controller)
    import eventlet; eventlet.monkey_patch()
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)