import requests
import json

# --- CONFIGURATION ---
url = "https://api.jolt.com/graphql"

# UPDATED: Using the exact custom headers you provided
headers = {
    "Content-Type": "application/json",
    "jolt_auth_token": "__775aea000eec4f5d945926919036a2ae",
    "jolt_companyid": "0005875b260d4c6a9c965f4e5e59b569"
}

# --- VARIABLES ---
# Required by the API to identify which group of locations to fetch
variables = {
    "mode": {
        "mode": "CONTENT_GROUP",
        "id": "Q29udGVudEdyb3VwOjAwMDU4NzViMjYwZDRjNmI2NDdhNjBjZDAxNDFlZDU2"
    }
}

# --- THE QUERY ---
# Simplified to match the schema (no 'edges/node' and no 'first:10')
query = """
query GetLocations($mode: ModeInput!) {
    locations(mode: $mode) {
        id
        name
    }
}
"""

# --- EXECUTION ---
print("Fetching data from Jolt...")

try:
    response = requests.post(url, headers=headers, json={'query': query, 'variables': variables})
    
    if response.status_code == 200:
        data = response.json()
        
        if 'errors' in data:
            # Pretty-print errors if they occur
            print("API Error:", json.dumps(data['errors'], indent=2))
        else:
            locations = data['data']['locations']
            print(f"\nSuccess! Found {len(locations)} locations:\n")
            
            for loc in locations:
                print(f"- {loc['name']} (ID: {loc['id']})")
    else:
        print(f"Server Error: {response.status_code}")
        print(response.text)

except Exception as e:
    print(f"Script Error: {e}")
