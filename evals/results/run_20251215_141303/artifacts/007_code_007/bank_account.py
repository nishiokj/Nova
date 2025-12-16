class BankAccount:
    """Simple bank account class.

    Features:
    - Initialize with an initial balance (defaults to 0.0). Negative initial balance is disallowed.
    - deposit(amount): adds funds (amount must be non-negative).
    - withdraw(amount): prevents overdraft; returns True if successful, False if insufficient funds.
    - get_balance(): returns current balance.
    """

    def __init__(self, initial_balance=0.0):
        if initial_balance < 0:
            raise ValueError("Initial balance cannot be negative")
        self._balance = float(initial_balance)

    def deposit(self, amount):
        """Deposit a non-negative amount into the account."""
        if amount < 0:
            raise ValueError("Deposit amount must be non-negative")
        self._balance += amount

    def withdraw(self, amount):
        """Attempt to withdraw amount. Return True if successful, False if insufficient funds."""
        if amount < 0:
            raise ValueError("Withdraw amount must be non-negative")
        if amount > self._balance:
            return False
        self._balance -= amount
        return True

    def get_balance(self):
        """Return the current account balance."""
        return self._balance
