def quicksort(arr):
    """Return a new list with the elements of arr sorted using quicksort.

    The input sequence is not modified.
    """
    # Work on a shallow copy to avoid mutating the input
    a = list(arr)
    if len(a) <= 1:
        return a.copy()
    pivot = a[len(a) // 2]
    left = [x for x in a if x < pivot]
    middle = [x for x in a if x == pivot]
    right = [x for x in a if x > pivot]
    return quicksort(left) + middle + quicksort(right)

# Optional: allow running a quick test when executed directly
if __name__ == "__main__":
    print(quicksort([3, 1, 4, 1, 5, 9, 2, 6]))
