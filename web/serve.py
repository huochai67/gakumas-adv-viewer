import functools
import http.server
import socketserver


class Handler(http.server.SimpleHTTPRequestHandler):
    # keep-alive: one connection per asset instead of one TIME_WAIT per request
    # (the page pulls a few hundred files, which otherwise exhausts the
    # Windows ephemeral port range and fails loads with ERR_ADDRESS_IN_USE)
    protocol_version = "HTTP/1.1"
    timeout = 30

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    # no allow_reuse_address: on Windows it lets a second server bind the same
    # port, and requests then land on a stale instance with the wrong cwd
    daemon_threads = True
    request_queue_size = 128

if __name__ == "__main__":
    handler = functools.partial(Handler, directory=".")
    print("serving on 8777", flush=True)
    Server(("127.0.0.1", 8777), handler).serve_forever()
