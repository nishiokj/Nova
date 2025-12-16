def fibonacci(n):
    """Return the nth Fibonacci number.

    fibonacci(0) == 0, fibonacci(1) == 1.
    n must be a non-negative integer.
    """
    if not isinstance(n, int) or n < 0:
        raise ValueError("n must be a non-negative integer")
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


if __name__ == "__main__":
    # quick manual test
    print(f"fibonacci(10) = {fibonacci(10)}")
