import logging
import os

# Setup logging
log_dir = 'logs'
os.makedirs(log_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(os.path.join(log_dir, 'control_main.log'))
    ]
)

print("hello world")
logging.info("Control script started")

for i in range(100):
	for x in range(1000):
		result = i + x
		print(result)
		if result % 10000 == 0:  # Log every 10000th calculation
			logging.info(f"Processed calculation: {i} + {x} = {result}")

