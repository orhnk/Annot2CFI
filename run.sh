if [ $# -eq 0 ]; then
    echo "Usage: ./run.sh <kobo-db-path>"
    exit 1
fi

# Run the application
node index.js $1 || exit

cd ./data/annotations/ || exit
git add --all
git commit -m "Update annotations"
git push
cd ../../ || exit

echo "Done updating annotations."

echo "Copying database as backup..."

unique_id=$(date +"%Y-%m-%d")

cp $1 ./data/backup/kobo_db_$unique_id.sqlite

echo "Backup complete."
