import os
import socket
import unittest

from app.ports import find_free_port, is_port_free


class PortTests(unittest.TestCase):
    def test_live_listener_is_not_available(self):
        with socket.socket() as listener:
            if os.name != "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("0.0.0.0", 0))
            listener.listen()
            port = listener.getsockname()[1]
            self.assertFalse(is_port_free(port))
            self.assertEqual(find_free_port(set(), port, port), 0)

    @unittest.skipIf(os.name == "nt", "POSIX TIME_WAIT reuse semantics")
    def test_stopped_server_with_time_wait_can_restart(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.settimeout(3)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port), timeout=3) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(3)
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b"")
                    client.shutdown(socket.SHUT_WR)
                    self.assertEqual(connection.recv(1), b"")
        # Verify the regression fixture really leaves a non-reusable bind busy.
        with socket.socket() as probe:
            with self.assertRaises(OSError):
                probe.bind(("0.0.0.0", port))
        self.assertTrue(is_port_free(port))
        self.assertEqual(find_free_port(set(), port, port), port)

    def test_invalid_ports_are_not_available(self):
        for port in (-1, 0, 65536):
            self.assertFalse(is_port_free(port))


if __name__ == "__main__":
    unittest.main()
