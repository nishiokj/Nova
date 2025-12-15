# prime_generator.py
# Approach: incremental trial division using previously found primes.
# Start by yielding 2, then consider only odd candidates.
# For each candidate, test divisibility by stored primes and stop when p*p > candidate
# (i.e., when we've tested all possible prime factors up to sqrt(candidate)).
# We store discovered primes and reuse them, so each candidate is tested only against
# primes up to its sqrt. This produces primes one at a time with good practical efficiency
# and minimal extra memory (only the list of primes found so far).

def prime_generator():
    """Yield prime numbers indefinitely.

    Yields:
        int: the next prime number (starting from 2).
    """
    # Handle the only even prime
    yield 2
    primes = [2]
    candidate = 3

    # Only test odd candidates
    while True:
        is_prime = True
        # Test divisibility by known primes up to sqrt(candidate)
        for p in primes:
            if p * p > candidate:
                break
            if candidate % p == 0:
                is_prime = False
                break
        if is_prime:
            primes.append(candidate)
            yield candidate
        candidate += 2
