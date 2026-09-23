import axios from 'axios';

async function main() {
  try {
    const res = await axios.get("https://www.redfin.com/stingray/do/location-autocomplete?location=Des+Moines,+IA&v=2", {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    console.log(res.data);
  } catch (err: any) {
    console.error(err.message);
  }
}
main();
