#!/usr/bin/env python3
"""Test TTS in subprocess on macOS"""

import multiprocessing as mp
import sys
import time


def test_tts_in_subprocess():
    """Run TTS in a subprocess to test if it works"""
    print(f'Subprocess PID: {mp.current_process().pid}', flush=True)

    try:
        import pyttsx3
        print('Importing pyttsx3...', flush=True)

        engine = pyttsx3.init()
        print('pyttsx3 initialized in subprocess', flush=True)

        # Try to speak
        engine.say('Testing audio from subprocess. Can you hear me?')
        print('Calling runAndWait...', flush=True)

        engine.runAndWait()
        print('runAndWait completed - did you hear audio?', flush=True)

    except Exception as e:
        print(f'ERROR in subprocess: {e}', flush=True)
        import traceback
        traceback.print_exc()


def test_tts_main_process():
    """Run TTS in main process for comparison"""
    print(f'Main process PID: {mp.current_process().pid}', flush=True)

    try:
        import pyttsx3
        engine = pyttsx3.init()
        engine.say('Testing audio from main process')
        engine.runAndWait()
        print('Main process TTS completed', flush=True)
    except Exception as e:
        print(f'ERROR in main process: {e}', flush=True)


if __name__ == '__main__':
    # Test 1: Main process (should work)
    print("\n=== Test 1: TTS in MAIN PROCESS ===")
    test_tts_main_process()
    time.sleep(1)

    # Test 2: Subprocess with fork (works on macOS if available)
    print("\n=== Test 2: TTS in SUBPROCESS (fork) ===")
    try:
        ctx = mp.get_context('fork')
        p = ctx.Process(target=test_tts_in_subprocess)
        p.start()
        p.join(timeout=10)
        print(f'Fork subprocess exited with code: {p.exitcode}')
    except Exception as e:
        print(f'Fork test failed: {e}')

    time.sleep(1)

    # Test 3: Subprocess with spawn (default on macOS Python 3.8+)
    print("\n=== Test 3: TTS in SUBPROCESS (spawn) ===")
    try:
        ctx = mp.get_context('spawn')
        p = ctx.Process(target=test_tts_in_subprocess)
        p.start()
        p.join(timeout=10)
        print(f'Spawn subprocess exited with code: {p.exitcode}')
    except Exception as e:
        print(f'Spawn test failed: {e}')
