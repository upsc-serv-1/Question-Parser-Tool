# Use the official lightweight Python image.
FROM python:3.11-slim

# Set working directory within the container
WORKDIR /app

# Install system dependencies often needed for parsers/parsing tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy only the requirements first to leverage Docker cache
COPY requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend code
COPY . .

# Expose default port 8000
EXPOSE 8000

# Command to run the API using uvicorn
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
