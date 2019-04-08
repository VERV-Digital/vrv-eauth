const express = require('express');
const path = require('path');
const util = require('util');
const session = require('express-session')
const bodyParser = require('body-parser')
const morgan = require('morgan')
const jwt = require('jsonwebtoken')
const Eauth = require('express-eauth');
const async = require("async");
const MobileDetect = require('mobile-detect')

const env = process.env.NODE_ENV || 'development';
const config = require(__dirname + '/config/config.json')[env];

const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// LOG
if (app.get('env') === 'development')
  app.use(morgan('dev'))

// issue, dev // maybe add salt with secret
app.set('secret', config.secret)

// initalize database
const db = require('./models');
const User = db.User;
const Session = db.Session;

// creat database if not exist // if force == true : drop table
async function initalize(){
  await User.sync();
  await Session.sync({force: true});
};
initalize();

// initalize sequelize with session store
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const sequelizeStore = new SequelizeStore({
  db: db.sequelize,
  table: 'Session'
})

app.use(session({
  secret: app.get('secret'),
  store: sequelizeStore,
  resave: false,
  saveUninitialized: true
}))

// Add body parser.
app.use(bodyParser.urlencoded({extended: false}))
app.use(bodyParser.json())

// eauth
const eauth1 = new Eauth({banner: config.banner});
const eauth2 = new Eauth({banner: config.banner, method: 'personal_sign'});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', async (req, res) => {
  if(req.session.address)
    res.render('logout', {address:req.session.address});
  else {
    md = new MobileDetect(req.headers['user-agent']);
    if (md.mobile()) {
      res.render('index', {method:'personal_sign'})
    }
    else {
      res.render('index', {method:'eth_signTypedData', qrcode:true})
    }
  }
});

const cookieParser = require('socket.io-cookie-parser')
io.use(cookieParser());
io.on('connection', function (socket) {
  socket.emit('init', { session_id: socket.request.cookies['connect.sid'].substr(2,32) });
  setTimeout(()=>{ socket.emit('refresh');socket.disconnect(true);console.log('socket disconnect') }, 180000);
});

async function eauthMiddleware(req, res, next) {
  var middleware = eauth1;
  md = new MobileDetect(req.headers['user-agent']);
  if (md.mobile())
    middleware = eauth2;

  async.series([middleware.bind(null, req, res)], function(err) {
    if(err)
      return next(err);
    next();
  });
}

// return Address or Confirm Code or status 400
app.get('/auth/:Address', eauthMiddleware, (req, res) => {
  req.eauth.message ? res.send(req.eauth.message) : res.status(400).send();
});

// return Address or status 400
app.post('/auth/:Message/:Signature', eauthMiddleware, (req, res) => {
  const address = req.eauth.recoveredAddress;

  if (!address)
    res.status(400).send();
  else {
    User.findOrCreate({ where: {"address": address} }).spread( (eauth,created) => {
      const token = jwt.sign(eauth.get({ plain: true }), app.get('secret'), {
        expiresIn: 60*15*1000 // session expire time deafault hardcode 15 min // SHOULD CONFIG
      })

      req.session.cookie.expires = 60*15*1000; // session expire time deafault hardcode 15 min // SHOULD CONFIG
      req.session.address_id = eauth.dataValues.id; // database id // oauth use
      req.session.address = address;
      req.session.token = token;

      res.json({
        success: true,
        message: 'Eauth Success',
        token: token
      })
    });
  }
});

function apiMiddleware(req, res, next) {
  const token = req.session.token;
  if (token) {
    // issue case: after server restart will pass verify cond,but token is expire, maybe should check database
    jwt.verify(token, app.get('secret'), function (err, decoded) {
      if (err) {
        return res.json({success: false, message: 'Failed to authenticate token.'})
      } else {
        req.decoded = decoded
        next()
      }
    })
  } 
  else {
    url = req.url ? util.format('/?url=%s', encodeURIComponent(req.url)) : '/';
    res.redirect(url)
  }
}

// oauth server # todo: make it optional
require('./components/oauth')(app, apiMiddleware)

const api = express.Router();

// api middleware
api.use(apiMiddleware);

// api logout
app.all('/logout', api, (req, res) => {
  req.session.destroy((err)=>{
    location = '/'
    if(req.body.url)
      location = req.body.url
    res.redirect(location)
  });
});

app.get('/user', api, (req, res) => {
  res.json({
    success: true,
    message: req.session.address
  });
});

app.get('/qrcode', api, async (req, res) => {
  // set session to logined
  if ( req.query.session_id && req.query.socket_id ) {
    s =  await sequelizeStore.get(req.query.session_id)
    if ( s )
      await sequelizeStore.set(req.query.session_id, req.session)
    // emit loggin message
    socket = io.clients().sockets[req.query.socket_id]
    if ( socket)
      await socket.emit('refresh')
  }

  // clean client session
  res.redirect('/logout')
});

// error handler
app.use(function(err, req, res, next) {
  res.status(err.status || 500);
  res.render('error', {
    message: err.message,
    error: app.get('env') === 'development' ? err : {}
  });
});

var listener = server.listen(process.env.PORT || 8080, () => {
  console.log('Listening on port ' + listener.address().port)
})
