const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());

// Proxy for MangaDex API calls
app.get('/api', async (req, res) => {
    try {
        const response = await axios.get(req.query.url);
        res.json(response.data);
    } catch (error) {
        res.status(error.response?.status || 500).send("Error fetching from API");
    }
});

// Proxy for MangaDex images to bypass hotlink protection
app.get('/image', async (req, res) => {
    try {
        const imageResponse = await axios.get(req.query.url, { 
            responseType: 'stream' 
        });
        imageResponse.data.pipe(res);
    } catch (error) {
        res.status(error.response?.status || 500).send("Error fetching image");
    }
});

app.listen(PORT, () => {
    console.log(`Proxy server listening on http://localhost:${PORT}`);
});