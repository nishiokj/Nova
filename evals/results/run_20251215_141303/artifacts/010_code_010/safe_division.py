def divide(a, b):
    try:
        return a / b
    except ZeroDivisionError:
        print("Error: Division by zero")
        return None
    except Exception as e:
        # Catch other invalid operations (e.g., wrong types) and report them
        print(f"Error: {e}")
        return None


if __name__ == "__main__":
    # Demonstration: dividing by zero should print an error and result in None
    result = divide(10, 0)
    print(result)
