#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
# IMPORTANT: Replace with your Google Cloud project ID
GCP_PROJECT_ID="saastart-lnd-dev-01"
# The region to deploy the service to
GCP_REGION="europe-west1"
# The name of the Cloud Run service
SERVICE_NAME="firecrawl-mcp-server-v2-01"
# The name of the Artifact Registry repository
ARTIFACT_REGISTRY_REPO="sas-lnd-docker-ar-dev-01"
# The name for the Docker image
IMAGE_NAME="$GCP_REGION-docker.pkg.dev/$GCP_PROJECT_ID/$ARTIFACT_REGISTRY_REPO/$SERVICE_NAME"

# --- Pre-flight checks ---
if [ "$GCP_PROJECT_ID" == "your-gcp-project-id" ]; then
  echo "🛑 Please update GCP_PROJECT_ID in this script with your Google Cloud project ID."
  exit 1
fi

# Check for required local environment variables
if [ -z "$FIRECRAWL_API_KEY" ]; then
  echo "🛑 FIRECRAWL_API_KEY environment variable is not set. Please set it locally and re-run."
  exit 1
fi

if [ -z "$FIRECRAWL_API_URL" ]; then
  echo "🛑 FIRECRAWL_API_URL environment variable is not set. Please set it locally and re-run."
  exit 1
fi

echo "--- Configuration ---"
echo "Project ID: $GCP_PROJECT_ID"
echo "Region: $GCP_REGION"
echo "Service Name: $SERVICE_NAME"
echo "Image Name: $IMAGE_NAME"
echo "---------------------"
read -p "Press Enter to continue or Ctrl+C to cancel..."

# --- 1. Enable Google Cloud services ---
echo "
🚀 Enabling required Google Cloud services..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com --project=$GCP_PROJECT_ID

# --- 2. Configure Docker to use gcloud credentials ---
echo "
🔑 Configuring Docker authentication..."
gcloud auth configure-docker $GCP_REGION-docker.pkg.dev

# --- 3. Create Artifact Registry repository (if it doesn't exist) ---
echo "
📦 Checking for Artifact Registry repository..."
if ! gcloud artifacts repositories describe $ARTIFACT_REGISTRY_REPO --location=$GCP_REGION --project=$GCP_PROJECT_ID &>/dev/null; then
  echo "Creating Artifact Registry repository '$ARTIFACT_REGISTRY_REPO'..."
  gcloud artifacts repositories create $ARTIFACT_REGISTRY_REPO \
    --repository-format=docker \
    --location=$GCP_REGION \
    --description="Repository for Firecrawl MCP server images" \
    --project=$GCP_PROJECT_ID
else
  echo "Artifact Registry repository '$ARTIFACT_REGISTRY_REPO' already exists."
fi

# --- 4. Build and push the Docker image using Cloud Build ---
echo "
🛠️  Building and pushing the Docker image with Cloud Build..."
gcloud builds submit --tag $IMAGE_NAME . --project=$GCP_PROJECT_ID

# --- 5. Deploy to Cloud Run ---
echo "
☁️  Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image $IMAGE_NAME \
  --platform managed \
  --region $GCP_REGION \
  --allow-unauthenticated \
  --port 3000 \
  --set-env-vars="CLOUD_SERVICE=true,FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY,FIRECRAWL_API_URL=$FIRECRAWL_API_URL" \
  --project=$GCP_PROJECT_ID

SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --platform managed --region $GCP_REGION --project=$GCP_PROJECT_ID --format 'value(status.url)')

echo "
✅ Deployment successful!"
echo "   Service URL: $SERVICE_URL"
echo ""
echo "You can now use this URL to configure your MCP clients."
echo "Example SSE URL for a client (V2 endpoint):"
echo "$SERVICE_URL/YOUR_API_KEY/v2/sse"
