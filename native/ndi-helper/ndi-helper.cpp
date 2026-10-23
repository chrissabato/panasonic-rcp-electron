// NDI receive helper. Built as x64 and run under Windows' x64 emulation,
// because NDI ships no Windows ARM64 library; the arm64 app talks to it over
// stdin/stdout (see src/ndi/helperSource.js).
//
// stdin, one command per line:
//   find <ip,ip,...>          also query these addresses directly, not just mDNS
//                             (the cameras' own IPs, so a firewall blocking mDNS can't hide them)
//   connect <channel> <ndi source name>
//   disconnect <channel>
// stdout, binary messages: u32 type, u32 payload length, payload (little endian)
//   type 1: UTF-8 JSON event
//           {"type":"sources","sources":[{"name":..,"url":..}]}
//           {"type":"status","channel":n,"status":"connecting"|"connected"}
//   type 2: video frame: u32 channel, u32 fourcc, u32 width, u32 height, u32 stride, then stride*height bytes
// stderr: plain-text log lines.
//
// One 30 Hz loop pulls the newest frame from each channel's frame sync and
// skips frames it has already sent. If the reader falls behind, the pipe
// fills and writes block, so frames are dropped rather than queued.
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <fcntl.h>
#include <io.h>
#include <windows.h>

#include <Processing.NDI.Lib.h>

#pragma comment(lib, "Processing.NDI.Lib.x64.lib")
#pragma comment(lib, "winmm.lib")

namespace {

constexpr uint32_t MSG_JSON = 1;
constexpr uint32_t MSG_FRAME = 2;
constexpr auto FRAME_PERIOD = std::chrono::microseconds(1000000 / 30);
constexpr auto STATS_PERIOD = std::chrono::seconds(5);

std::string jsonString(const char* s) {
    std::string out = "\"";
    for (const char* p = s ? s : ""; *p; ++p) {
        unsigned char c = static_cast<unsigned char>(*p);
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 0x20) { char buf[8]; snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
        else out += static_cast<char>(c);
    }
    return out + "\"";
}

void writeMessage(uint32_t type, const void* header, uint32_t headerLen, const void* body, uint32_t bodyLen) {
    uint32_t prefix[2] = { type, headerLen + bodyLen };
    fwrite(prefix, sizeof prefix, 1, stdout);
    if (headerLen) fwrite(header, headerLen, 1, stdout);
    if (bodyLen) fwrite(body, bodyLen, 1, stdout);
    fflush(stdout);
}

void writeJson(const std::string& json) {
    writeMessage(MSG_JSON, nullptr, 0, json.data(), static_cast<uint32_t>(json.size()));
}

struct Channel {
    NDIlib_recv_instance_t recv = nullptr;
    NDIlib_framesync_instance_t sync = nullptr;
    std::string source;
    int64_t lastTimestamp = -1;
    bool connected = false;
    uint64_t framesSent = 0;
    int width = 0, height = 0;

    void close() {
        if (sync) NDIlib_framesync_destroy(sync);
        if (recv) NDIlib_recv_destroy(recv);
        *this = Channel();
    }
};

struct Command { std::string verb; std::string rest; };

std::mutex commandsLock;
std::vector<Command> commands;
std::atomic<bool> inputClosed{ false };

void readCommands() {
    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        size_t space = line.find(' ');
        Command cmd{ line.substr(0, space), space == std::string::npos ? "" : line.substr(space + 1) };
        std::lock_guard<std::mutex> guard(commandsLock);
        commands.push_back(cmd);
    }
    inputClosed = true; // the app closed the pipe: time to exit
}

void connect(Channel& ch, int id, const std::string& source) {
    ch.close();
    NDIlib_recv_create_v3_t settings;
    settings.color_format = NDIlib_recv_color_format_UYVY_BGRA;
    settings.bandwidth = NDIlib_recv_bandwidth_lowest;
    settings.allow_video_fields = false;
    std::string name = "PanasonicRCP CH" + std::to_string(id);
    settings.p_ndi_recv_name = name.c_str();
    ch.recv = NDIlib_recv_create_v3(&settings);
    if (!ch.recv) {
        fprintf(stderr, "CH%d: could not create receiver\n", id);
        return;
    }
    NDIlib_source_t src;
    src.p_ndi_name = source.c_str();
    NDIlib_recv_connect(ch.recv, &src);
    ch.sync = NDIlib_framesync_create(ch.recv);
    ch.source = source;
    writeJson("{\"type\":\"status\",\"channel\":" + std::to_string(id) + ",\"status\":\"connecting\"}");
    fprintf(stderr, "CH%d: connecting to %s\n", id, source.c_str());
}

NDIlib_find_instance_t createFinder(const std::string& extraIps) {
    NDIlib_find_create_t settings;
    settings.p_extra_ips = extraIps.empty() ? nullptr : extraIps.c_str();
    NDIlib_find_instance_t finder = NDIlib_find_create_v2(&settings);
    if (!finder) fprintf(stderr, "NDI finder could not be created\n");
    return finder;
}

void applyCommands(std::map<int, Channel>& channels, NDIlib_find_instance_t& finder) {
    std::vector<Command> pending;
    {
        std::lock_guard<std::mutex> guard(commandsLock);
        pending.swap(commands);
    }
    for (const auto& cmd : pending) {
        if (cmd.verb == "find") {
            if (finder) NDIlib_find_destroy(finder);
            finder = createFinder(cmd.rest);
            fprintf(stderr, "finding with extra IPs: %s\n", cmd.rest.empty() ? "(none)" : cmd.rest.c_str());
            continue;
        }
        // connect/disconnect: "<channel>[ <source name>]"
        size_t space = cmd.rest.find(' ');
        int id = atoi(cmd.rest.substr(0, space).c_str());
        std::string source = space == std::string::npos ? "" : cmd.rest.substr(space + 1);
        if (id < 1 || id > 4) continue;
        if (cmd.verb == "connect" && !source.empty()) {
            connect(channels[id], id, source);
        } else if (cmd.verb == "disconnect") {
            channels[id].close();
        }
    }
}

void publishSources(NDIlib_find_instance_t finder) {
    uint32_t count = 0;
    const NDIlib_source_t* sources = NDIlib_find_get_current_sources(finder, &count);
    std::string json = "{\"type\":\"sources\",\"sources\":[";
    for (uint32_t i = 0; i < count; ++i) {
        if (i) json += ",";
        json += "{\"name\":" + jsonString(sources[i].p_ndi_name) + ",\"url\":" + jsonString(sources[i].p_url_address) + "}";
    }
    writeJson(json + "]}");
}

void pollChannel(int id, Channel& ch) {
    if (!ch.sync) return;

    bool connected = NDIlib_recv_get_no_connections(ch.recv) > 0;
    if (connected != ch.connected) {
        ch.connected = connected;
        writeJson("{\"type\":\"status\",\"channel\":" + std::to_string(id) + ",\"status\":\"" + (connected ? "connected" : "connecting") + "\"}");
    }

    NDIlib_video_frame_v2_t frame;
    NDIlib_framesync_capture_video(ch.sync, &frame, NDIlib_frame_format_type_progressive);
    if (frame.p_data && frame.timestamp != ch.lastTimestamp) {
        ch.lastTimestamp = frame.timestamp;
        ch.width = frame.xres;
        ch.height = frame.yres;
        uint32_t header[5] = {
            static_cast<uint32_t>(id), static_cast<uint32_t>(frame.FourCC),
            static_cast<uint32_t>(frame.xres), static_cast<uint32_t>(frame.yres),
            static_cast<uint32_t>(frame.line_stride_in_bytes),
        };
        writeMessage(MSG_FRAME, header, sizeof header, frame.p_data,
            static_cast<uint32_t>(frame.line_stride_in_bytes) * static_cast<uint32_t>(frame.yres));
        ch.framesSent++;
    }
    NDIlib_framesync_free_video(ch.sync, &frame);
}

} // namespace

int main() {
    _setmode(_fileno(stdout), _O_BINARY);
    timeBeginPeriod(1); // 1 ms sleep granularity instead of ~15.6 ms

    if (!NDIlib_initialize()) {
        fprintf(stderr, "NDI could not initialize: unsupported CPU\n");
        return 2;
    }
    fprintf(stderr, "NDI %s\n", NDIlib_version());

    NDIlib_find_instance_t finder = createFinder("");
    if (!finder) return 3;
    publishSources(finder);

    std::thread(readCommands).detach();

    std::map<int, Channel> channels;
    auto next = std::chrono::steady_clock::now();
    auto nextStats = next + STATS_PERIOD;
    std::map<int, uint64_t> sentAtLastStats;

    while (!inputClosed) {
        applyCommands(channels, finder);
        if (finder && NDIlib_find_wait_for_sources(finder, 0)) publishSources(finder);
        for (auto& [id, ch] : channels) pollChannel(id, ch);

        auto now = std::chrono::steady_clock::now();
        if (now >= nextStats) {
            std::string line = "stats:";
            for (auto& [id, ch] : channels) {
                if (!ch.sync) continue;
                double fps = (ch.framesSent - sentAtLastStats[id]) / std::chrono::duration<double>(STATS_PERIOD).count();
                sentAtLastStats[id] = ch.framesSent;
                char buf[96];
                snprintf(buf, sizeof buf, " CH%d %dx%d %.1f fps", id, ch.width, ch.height, fps);
                line += buf;
            }
            fprintf(stderr, "%s\n", line.c_str());
            nextStats += STATS_PERIOD;
        }

        next += FRAME_PERIOD;
        if (next < now) next = now; // fell behind (blocked on a full pipe): don't burst to catch up
        std::this_thread::sleep_until(next);
    }

    for (auto& [id, ch] : channels) ch.close();
    if (finder) NDIlib_find_destroy(finder);
    NDIlib_destroy();
    timeEndPeriod(1);
    return 0;
}
