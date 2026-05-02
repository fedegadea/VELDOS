const express = require("express")
const path = require("path")
const app = express()

app.use(express.static(path.join(__dirname, "/public")))

if (require.main === module) {
    app.listen(process.env.PORT || 3000, function(){
        console.log("Veld OS — servidor iniciado en puerto " + (process.env.PORT || 3000))
    })
}

module.exports = app

// Sistema de gestión Veld OS
app.get("/sistema", (req, res) => {
    res.sendFile(__dirname + "/views/index.html")
})

// Root → sistema
app.get("/", (req, res) => {
    res.sendFile(__dirname + "/views/index.html")
})
