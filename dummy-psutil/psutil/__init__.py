import sys
import os

# Dynamically add Termux's system site-packages to ensure we load the precompiled patched psutil C extension
system_site_packages = "/data/data/com.termux/files/usr/lib/python3.13/site-packages"
if system_site_packages not in sys.path:
    # Insert near the beginning but after current working dir
    sys.path.insert(1, system_site_packages)

try:
    from psutil import *
    # Re-export everything from system psutil
    import psutil
    globals().update({k: v for k, v in psutil.__dict__.items() if not k.startswith('__')})
except ImportError as e:
    # Provide dummy fallback functions if system psutil isn't accessible (e.g. during certain build tool operations)
    def cpu_count(*args, **kwargs): return 4
    def cpu_percent(*args, **kwargs): return 0.0
    def virtual_memory(*args, **kwargs):
        class DummyVM:
            total = 8 * 1024 * 1024 * 1024
            available = 4 * 1024 * 1024 * 1024
            percent = 50.0
            used = 4 * 1024 * 1024 * 1024
            free = 4 * 1024 * 1024 * 1024
        return DummyVM()
    def process_iter(*args, **kwargs): return []
    class Error(Exception): pass
    class NoSuchProcess(Error): pass
    class AccessDenied(Error): pass
    class TimeoutExpired(Error): pass
