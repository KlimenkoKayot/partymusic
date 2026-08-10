package main

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 8192
)

// Client is a single WebSocket connection belonging to one room.
type Client struct {
	room *Room
	conn *websocket.Conn
	send chan []byte
	name string
}

func NewClient(room *Room, conn *websocket.Conn, name string) *Client {
	return &Client{
		room: room,
		conn: conn,
		send: make(chan []byte, 32),
		name: name,
	}
}

// readPump pumps messages from the WebSocket connection to the room.
func (c *Client) readPump() {
	defer func() {
		c.room.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			break
		}
		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("bad message from %s: %v", c.name, err)
			continue
		}
		// RTT/clock probe: answer immediately from the read loop, bypassing
		// the room's serialized event loop, so queueing delay does not
		// inflate the measured ping. We echo the client timestamp and attach
		// the server time, letting the client estimate its clock offset
		// NTP-style: offset = serverTime - (t + rtt/2). All clients then
		// share one reference clock, which is what makes sample-accurate
		// convergence possible.
		if msg.Type == "ping" {
			var p struct {
				T int64 `json:"t"`
			}
			_ = json.Unmarshal(msg.Data, &p)
			select {
			case c.send <- newMessage("pong", map[string]interface{}{
				"t":          p.T,
				"serverTime": time.Now().UnixMilli(),
			}):
			default:
			}
			continue
		}
		c.room.broadcast <- inbound{client: c, msg: msg}
	}
}

// writePump pumps messages from the room to the WebSocket connection.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// The room closed the channel.
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
